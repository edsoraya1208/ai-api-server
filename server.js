import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Allow requests from your Vercel app
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://erducate.vercel.app',
    'https://erducate2.vercel.app'
  ],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: '✅ ERD Detection API is running!',
    timestamp: new Date().toISOString()
  });
});

// Your AI detection endpoint
app.post('/detect-erd', async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: 'Missing imageUrl' });
    }

    console.log('🔍 Analyzing ERD:', imageUrl);

    // Optimize image
    const optimizedUrl = imageUrl.replace('/upload/', '/upload/w_1200,q_auto/');

    // Download image (60 second timeout for Render)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const imageResponse = await fetch(optimizedUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!imageResponse.ok) {
      throw new Error('Failed to fetch image');
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');

    // Call OpenRouter AI with improved prompt
    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite-preview-09-2025',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this ERD diagram. Return ONLY valid JSON, no markdown.

CRITICAL DETECTION RULES (MUST FOLLOW):
1. PRIMARY KEYS are UNDERLINED text - dont rely on name alone, look for underline
2. MULTIVALUED attributes have DOUBLE OVALS/circles - detect the double border
3. CARDINALITY must be read from BOTH sides of relationship 
   - Look for (0,M), (1,1), (0,1), (1,M) notation near EACH entity
   - OR look for M, 1, N letters near entities
   - from="EntityA" to="EntityB" means: EntityA's cardinality goes in cardinalityFrom, EntityB's in cardinalityTo
   - Example: Patient(0,M)─visit─(1,1)Doctor → from="Patient", cardinalityFrom="0..M", to="Doctor", cardinalityTo="1..1"

CARDINALITY MAPPING:
- (0,M) or M or 0..* → "0..M" (optional, many)
- (1,M) or 1..* → "1..M" (mandatory, at least one)
- (0,1) or 0..1 → "0..1" (optional, at most one)  
- (1,1) or just 1 → "1..1" (mandatory, exactly one)
- If only max shown: M→"0..M", 1→"0..1"
- ⚠️ Read CAREFULLY: "M 1" means min=1 max=M → "1..M", NOT "0..M"

REJECT IF:
- EERD features: (d) symbols, triangles, subclass/superclass
- Crow's Foot notation: >< |< symbols
- Not a database diagram

DETECT ALL:
✅ Entities (strong=single rectangle, weak=double rectangle)
✅ Relationships (strong=single diamond, weak=double diamond) with cardinality from BOTH sides
✅ Attributes with correct subTypes:
   - primary_key: UNDERLINED text only (dont assume from name)
   - multivalued: DOUBLE circle/oval border
   - derived: dashed circle/oval
   - composite: attribute connected to sub-attributes
   - foreign_key: key from another entity
   - regular: normal single circle/oval

RESPONSE FORMAT:
{
  "isERD": true,
  "elements": [
    {"id": "el_1", "name": "Patient", "type": "entity", "subType": "strong", "confidence": 95},
    {"id": "el_2", "name": "visit", "type": "relationship", "subType": "strong", "from": "Patient", "to": "Doctor", "cardinalityFrom": "0..M", "cardinalityTo": "1..1", "confidence": 88},
    {"id": "el_3", "name": "PatientID", "type": "attribute", "subType": "primary_key", "belongsTo": "Patient", "belongsToType": "entity", "confidence": 92}
  ]
}

REQUIRED FIELDS:
- Each element: unique "id" (el_1, el_2...)
- Entities: "subType" is "strong" or "weak"
- Relationships: "subType" is "strong" or "weak", MUST have "from", "to", "cardinalityFrom", "cardinalityTo"
- Attributes: MUST have "belongsTo" and "belongsToType" ("entity"/"relationship"/"attribute")
- Confidence: 95-100 crystal clear | 80-94 clear | 70-79 requires interpretation | 60-69 unclear/guessing | <60 very uncertain
- Relationships: max confidence is 88 for relationships, DON'T exceed.
- If cardinality OR attribute border unclear → max confidence 75

Return ONLY the JSON object.`
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}` }
            }
          ]
        }],
        temperature: 0.3,
        max_tokens: 3000
      })
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      throw new Error(`OpenRouter failed: ${aiResponse.statusText} - ${errorText}`);
    }

    const aiData = await aiResponse.json();
    const content = aiData.choices[0].message.content;
    
    // Clean markdown if present
    const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(cleanContent);

    // Ensure all elements have unique IDs
    if (result.isERD && result.elements) {
      result.elements = result.elements.map((el, idx) => ({
        ...el,
        id: el.id || `el_${idx + 1}`
      }));
    }

    console.log('✅ Detection complete');
    return res.status(200).json(result);

  } catch (error) {
    console.error('❌ Error:', error);
    
    if (error.name === 'AbortError') {
      return res.status(408).json({ 
        error: 'Request timeout',
        message: 'Image analysis took too long',
        isERD: false
      });
    }
    
    return res.status(500).json({ 
      error: 'AI detection failed',
      message: error.message,
      isERD: false
    });
  }
});

// 🆕 Rubric analysis endpoint - NOW ACCEPTS TEXT INSTEAD OF FILE
app.post('/detect-rubric', async (req, res) => {
  try {
    const { rubricText } = req.body;
    if (!rubricText) {
      return res.status(400).json({ error: 'Missing rubricText' });
    }
    console.log('🔍 Analyzing rubric text:', rubricText.substring(0, 100) + '...');
    // Call OpenRouter AI with text-only prompt
    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout',
        messages: [{
          role: 'user',
          content: `Analyze this grading rubric text. Return ONLY valid JSON with no markdown formatting.

RUBRIC TEXT:
${rubricText}

SCOPE - WE EXTRACT:
✅ Rubrics for ERD diagram grading
✅ Grading categories (Entities, Relationships, Attributes, Keys, Notation, etc.)
✅ Point allocations per category
✅ Grading criteria/descriptions WITH FORMULAS
✅ Total marks

❌ OUT OF SCOPE (reject if found):
- Rubrics for SQL queries, normalization, or non-ERD topics
- Completely unreadable/corrupted text
- Non-grading content

IF NOT AN ERD RUBRIC:
{"isERDRubric":false,"reason":"This rubric is for SQL queries, not ERD diagrams"}

IF IS AN ERD RUBRIC:
{"isERDRubric":true,"totalPoints":100,"criteria":[{"category":"Entities","maxPoints":30,"description":"All entities correctly identified: 2 x 15 = 30"},{"category":"Relationships","maxPoints":30,"description":"Cardinality correct: 0.5 x 60 = 30"}],"notes":"Rubric emphasizes correct notation"}

CRITICAL RULES:
- Return ONLY valid JSON, no markdown code blocks, no extra text
- Each criterion MUST have: category, maxPoints, description
- **PRESERVE FORMULAS IN DESCRIPTION**: If rubric says "0.5 x 16 = 8", include "0.5 x 16" in the description field like "Cardinality correctly identified: 0.5 x 16"
- If points not stated, estimate based on emphasis
- Extract ALL grading aspects mentioned
- Be concise but capture all important criteria`

        }],
        temperature: 0.3,
        max_tokens: 2000
      })
    });
    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('OpenRouter error:', errorText);
      throw new Error(`OpenRouter failed: ${aiResponse.statusText}`);
    }
    const aiData = await aiResponse.json();
    // Validate AI response structure
    if (!aiData.choices || !aiData.choices[0] || !aiData.choices[0].message) {
      console.error('Invalid AI response structure:', JSON.stringify(aiData, null, 2));
      throw new Error('AI returned invalid response structure');
    }
    const content = aiData.choices[0].message.content;
    console.log('Raw AI response:', content.substring(0, 200) + '...'); // Log first 200 chars

    // Around line 240-260 in your server.js
    const cleanContent = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .replace(/\n/g, ' ')           // ✅ Remove newlines
      .replace(/\s+/g, ' ')          // ✅ Normalize whitespace
      .trim();

    // Add retry logic with fallback
    let result;
    try {
      result = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error('❌ First parse attempt failed, trying to fix...');
      
      // ✅ Try to auto-fix common issues
      const fixedContent = cleanContent
        .replace(/,\s*}/g, '}')      // Remove trailing commas
        .replace(/,\s*]/g, ']')      // Remove trailing commas in arrays
        .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":'); // Fix unquoted keys
      
      try {
        result = JSON.parse(fixedContent);
        console.log('✅ Fixed and parsed successfully');
      } catch (secondError) {
        console.error('❌ Content that failed:', cleanContent);
        throw new Error('AI returned invalid JSON format');
      }
    }

    // Validate result structure
    if (!result || typeof result !== 'object') {
      throw new Error('AI response is not a valid object');
    }
    console.log('✅ Rubric analysis complete');
    return res.status(200).json(result);
  } catch (error) {
    console.error('❌ Error:', error);
    
    return res.status(500).json({ 
      error: 'Rubric analysis failed',
      message: error.message,
      isERDRubric: false
    });
  }
});

// Bind to 0.0.0.0 for Render compatibility
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// 🆕 Auto-grading endpoint (HYBRID APPROACH - FLEXIBLE)
app.post('/autograde-erd', async (req, res) => {
  try {
    const { studentElements, correctAnswer, rubricStructured } = req.body;

    // Validate inputs
    if (!studentElements || !correctAnswer || !correctAnswer.elements) {
      return res.status(400).json({ 
        error: 'Missing required data',
        message: 'Need studentElements, correctAnswer, and rubricStructured'
      });
    }

    console.log('🎓 Auto-grading submission...');
    console.log('  - Student elements:', studentElements.length);
    console.log('  - Correct elements:', correctAnswer.elements.length);
    console.log('  - Has rubric:', !!rubricStructured);

    // ===========================
    // STEP 1: CODE DOES THE MATH
    // ===========================
    const grading = calculateGrades(studentElements, correctAnswer.elements, rubricStructured);
    
    console.log('📊 Calculated scores:', grading._debug);

    // ===========================
    // STEP 2: AI GENERATES FEEDBACK ONLY
    // ===========================
    const prompt = `You are an ERD grading feedback assistant helping students improve their database design skills.

**GRADING RESULTS (Already calculated - DO NOT recalculate):**
Total Score: ${grading.totalScore} / ${grading.maxScore}

**Category Breakdown:**
${grading.breakdown.map(b => `- ${b.category}: ${b.earned}/${b.max} points`).join('\n')}

**What the student got CORRECT:**
${JSON.stringify(grading.correctElements, null, 2)}

**What the student is MISSING:**
${JSON.stringify(grading.missingElements, null, 2)}

**What the student got INCORRECT:**
${JSON.stringify(grading.incorrectElements, null, 2)}

**YOUR INSTRUCTIONS:**
1. **CHECK FOR NAMING NOTES:** If a correct item says something like "(you called it 'X')", **YOU MUST MENTION THIS** in the feedback to educate the student.
   - Example output: "You correctly identified the 'Sign' relationship (which you labeled 'Has'). This is acceptable."
2. **Be Specific:** Do not just say "All relationships correct." If there was a naming difference allowed, point it out.
3. **Tone:** Encouraging but educational. Explain *why* errors matter.

**FEEDBACK FORMAT EXAMPLES:**

CORRECT section example:
- "You correctly identified Student, Course, and Professor entities"
- "The Enrolls relationship correctly connects Student and Course. Note: You labeled this 'Takes', which is acceptable."

MISSING section example:
- "Department entity - Without this, you cannot track which department each professor belongs to"

INCORRECT section example:
- "The Advises relationship cardinality is one-to-one but should be one-to-many"

**RETURN FORMAT (JSON only, no markdown, no extra text):**
{
  "breakdown": [
    {
      "category": "Entities",
      "feedback": "You correctly identified Student, Course, and Professor. Missing: Department entity is needed to organize professors by their departments."
    },
    {
      "category": "Cardinality",
      "feedback": "Most cardinalities are correct. However, the Advises relationship should be one-to-many (one professor advises multiple students), not one-to-one."
    }
  ],
  "feedback": {
    "correct": [
      "All three main entities (Student, Course, Professor) are correctly identified",
      "The Enrolls relationship correctly connects Student and Course with many-to-many cardinality"
    ],
    "missing": [
      "Department entity - Without this, you cannot track which department each professor belongs to",
      "Teaches relationship between Professor and Course - needed to track which professors teach which courses"
    ],
    "incorrect": [
      "The Advises relationship cardinality is one-to-one but should be one-to-many because one professor can advise multiple students"
    ]
  },
  "overallComment": "Great work! You correctly identified 96% of the required elements. Focus on reviewing relationship cardinalities and ensure all necessary entities are included to support the required functionality."
}`;

    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite-preview-09-2025',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 2500
      })
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      throw new Error(`OpenRouter failed: ${aiResponse.statusText} - ${errorText}`);
    }

    const aiData = await aiResponse.json();
    const content = aiData.choices[0].message.content;

    const cleanContent = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    console.log('📊 AI feedback generated (first 300 chars):', cleanContent.substring(0, 300));

    let feedbackData;
    try {
      feedbackData = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error('❌ AI returned invalid JSON:', cleanContent);
      feedbackData = {
        breakdown: grading.breakdown.map(b => ({
          category: b.category,
          feedback: `You earned ${b.earned} out of ${b.max} points in this category.`
        })),
        feedback: {
          correct: Object.keys(grading.correctElements).map(k => `${k}: ${grading.correctElements[k]} correct`),
          missing: Object.keys(grading.missingElements).flatMap(k => grading.missingElements[k]),
          incorrect: Object.keys(grading.incorrectElements).flatMap(k => grading.incorrectElements[k])
        },
        overallComment: `You scored ${grading.totalScore} out of ${grading.maxScore} points.`
      };
    }

    // ===========================
    // STEP 3: MERGE CODE MATH + AI FEEDBACK
    // ===========================
    const finalResult = {
      totalScore: grading.totalScore,
      maxScore: grading.maxScore,
      breakdown: grading.breakdown.map((item, i) => ({
        category: item.category,
        earned: item.earned,
        max: item.max,
        feedback: feedbackData.breakdown[i]?.feedback || `You earned ${item.earned}/${item.max} points.`
      })),
      feedback: feedbackData.feedback,
      overallComment: feedbackData.overallComment,
      _debug: grading._debug
    };

    console.log('✅ Auto-grading complete:', finalResult.totalScore, '/', finalResult.maxScore);
    return res.status(200).json(finalResult);

  } catch (error) {
    console.error('❌ Auto-grading error:', error);
    
    return res.status(500).json({ 
      error: 'Auto-grading failed',
      message: error.message
    });
  }
});

// ===========================
// DETERMINISTIC GRADING FUNCTION (SMART MATCHING + FEEDBACK CONTEXT)
// ===========================
function calculateGrades(studentElements, correctElements, rubric) {
  const result = {
    totalScore: 0,
    maxScore: rubric.totalPoints,
    breakdown: [],
    correctElements: {},
    missingElements: {},
    incorrectElements: {},
    _debug: {}
  };

  const entityMap = {}; 

  rubric.criteria.forEach(criterion => {
    const { category, maxPoints, description } = criterion;
    const multiplierMatch = description.match(/([\d.]+)\s*x\s*(\d+)/);
    let multiplier = 1;
    let expectedCount = 0;
    
    if (multiplierMatch) {
      multiplier = parseFloat(multiplierMatch[1]);
      expectedCount = parseInt(multiplierMatch[2]);
    }

    let correctCount = 0;
    let missing = [];
    let incorrect = [];
    let correctItems = [];

    const categoryLower = category.toLowerCase();

    // ===========================
    // A. ENTITY MATCHING
    // ===========================
    if (categoryLower.includes('entit')) {
      const correctEntities = correctElements.filter(e => e.type === 'entity');
      const studentEntities = studentElements.filter(e => e.type === 'entity');
      if (!multiplierMatch) expectedCount = correctEntities.length;
      
      correctEntities.forEach(ce => {
        const match = studentEntities.find(se => 
           areStringsSemanticallySimilar(se.name, ce.name) && se.subType === ce.subType
        );
        
        if (match) {
          correctCount++;
          entityMap[match.name] = ce.name;

          // FEEDBACK TWEAK: If names are slightly different, note it for the AI
          if (match.name !== ce.name) {
             correctItems.push(`${ce.name} (you called it '${match.name}')`);
          } else {
             correctItems.push(ce.name);
          }
        } else {
          missing.push(ce.name);
        }
      });
    }

    // ===========================
    // B. ATTRIBUTES
    // ===========================
    else if (categoryLower.includes('attribute') || categoryLower.includes('key')) {
      const isPK = categoryLower.includes('primary') || categoryLower.includes('key');
      const targetSubType = isPK ? 'primary_key' : null;
      const correctAttrs = correctElements.filter(e => e.type === 'attribute' && (!targetSubType || e.subType === targetSubType));
      const studentAttrs = studentElements.filter(e => e.type === 'attribute' && (!targetSubType || e.subType === targetSubType));
      if (!multiplierMatch) expectedCount = correctAttrs.length;
      
      correctAttrs.forEach(ca => {
        const match = studentAttrs.find(sa => {
          const nameMatch = areStringsSemanticallySimilar(sa.name, ca.name);
          const mappedParent = entityMap[sa.belongsTo] || sa.belongsTo;
          const parentMatch = areStringsSemanticallySimilar(mappedParent, ca.belongsTo);
          return nameMatch && parentMatch;
        });
        
        if (match) {
          correctCount++;
          correctItems.push(`${ca.name} (${ca.belongsTo})`);
        } else {
          missing.push(`${ca.name} in ${ca.belongsTo}`);
        }
      });
    }

    // ===========================
    // C. RELATIONSHIPS (The Feedback Fix is Here!)
    // ===========================
    else if (categoryLower.includes('relationship') && !categoryLower.includes('cardinality')) {
      const correctRels = correctElements.filter(e => e.type === 'relationship');
      const studentRels = studentElements.filter(e => e.type === 'relationship');
      if (!multiplierMatch) expectedCount = correctRels.length;
      
      correctRels.forEach(cr => {
        const match = studentRels.find(sr => {
           const sFrom = entityMap[sr.from] || sr.from;
           const sTo = entityMap[sr.to] || sr.to;
           const forward = areStringsSemanticallySimilar(sFrom, cr.from) && areStringsSemanticallySimilar(sTo, cr.to);
           const reverse = areStringsSemanticallySimilar(sFrom, cr.to) && areStringsSemanticallySimilar(sTo, cr.from);
           const nameMatch = areStringsSemanticallySimilar(sr.name, cr.name);
           return (forward || reverse) || (nameMatch && (forward || reverse));
        });
        
        if (match) {
          correctCount++;
          // ✨ NEW FEEDBACK LOGIC ✨
          // If the name is different (e.g., 'sign' vs 'has'), tell the AI about it.
          if (!areStringsSemanticallySimilar(match.name, cr.name)) {
             correctItems.push(`${cr.name} (Structure correct, but you named it '${match.name}')`); 
          } else {
             correctItems.push(`${cr.name} (${cr.from} ↔ ${cr.to})`);
          }
        } else {
          missing.push(`${cr.name} between ${cr.from} and ${cr.to}`);
        }
      });
    }

    // ===========================
    // D. CARDINALITY (Unchanged)
    // ===========================
    else if (categoryLower.includes('cardinality')) {
      const correctRels = correctElements.filter(e => e.type === 'relationship');
      const studentRels = studentElements.filter(e => e.type === 'relationship');
      const relationshipCount = correctRels.length;
      const checksPerRelationship = expectedCount / relationshipCount;
      const useMinMax = (checksPerRelationship >= 3.5);

      correctRels.forEach(cr => {
         const sr = studentRels.find(s => {
           const sFrom = entityMap[s.from] || s.from;
           const sTo = entityMap[s.to] || s.to;
           const forward = areStringsSemanticallySimilar(sFrom, cr.from) && areStringsSemanticallySimilar(sTo, cr.to);
           const reverse = areStringsSemanticallySimilar(sFrom, cr.to) && areStringsSemanticallySimilar(sTo, cr.from);
           return forward || reverse;
         });

         if (sr) {
            const sFrom = entityMap[sr.from] || sr.from;
            const isFlipped = areStringsSemanticallySimilar(sFrom, cr.to); 
            const studentFromVal = isFlipped ? sr.cardinalityTo : sr.cardinalityFrom;
            const studentToVal = isFlipped ? sr.cardinalityFrom : sr.cardinalityTo;

            if (useMinMax) {
                const [cFromMin, cFromMax] = (cr.cardinalityFrom || '..').split('..');
                const [cToMin, cToMax] = (cr.cardinalityTo || '..').split('..');
                const [sFromMin, sFromMax] = (studentFromVal || '..').split('..');
                const [sToMin, sToMax] = (studentToVal || '..').split('..');

                if (areStringsSemanticallySimilar(sFromMin, cFromMin)) { correctCount++; correctItems.push(`${cr.name} start-min`); }
                if (areStringsSemanticallySimilar(sFromMax, cFromMax)) { correctCount++; correctItems.push(`${cr.name} start-max`); }
                if (areStringsSemanticallySimilar(sToMin, cToMin)) { correctCount++; correctItems.push(`${cr.name} end-min`); }
                if (areStringsSemanticallySimilar(sToMax, cToMax)) { correctCount++; correctItems.push(`${cr.name} end-max`); }
            } else {
                if ((studentFromVal || '').includes(cr.cardinalityFrom) || (cr.cardinalityFrom || '').includes(studentFromVal)) {
                    correctCount++; correctItems.push(`${cr.name} start`);
                }
                if ((studentToVal || '').includes(cr.cardinalityTo) || (cr.cardinalityTo || '').includes(studentToVal)) {
                    correctCount++; correctItems.push(`${cr.name} end`);
                }
            }
         } else {
             missing.push(`Cardinality for ${cr.name}`);
         }
      });
    }

    if (!multiplierMatch && expectedCount > 0) multiplier = maxPoints / expectedCount;
    const earned = Math.min(correctCount * multiplier, maxPoints);
    result.breakdown.push({ category, earned: parseFloat(earned.toFixed(2)), max: maxPoints, feedback: '' });
    result.totalScore += earned;
    result.correctElements[category] = correctItems;
    result.missingElements[category] = missing;
    result.incorrectElements[category] = incorrect;
    result._debug[category] = { expectedCount, correctCount, multiplier, missing };
  });

  result.totalScore = parseFloat(result.totalScore.toFixed(2));
  return result;
}

// HELPER: Fuzzy String Matcher (Replaces normalizeString)
function areStringsSemanticallySimilar(str1, str2) {
  if (!str1 || !str2) return false;
  // 1. Direct match
  if (str1.trim().toLowerCase() === str2.trim().toLowerCase()) return true;
  // 2. Normalize (remove _ and spaces)
  const clean1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const clean2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean1 === clean2) return true;
  // 3. Word Bag (handles "Agent Insurance" vs "Insurance Agent")
  const words1 = str1.toLowerCase().split(/[\s_]+/).sort().join('');
  const words2 = str2.toLowerCase().split(/[\s_]+/).sort().join('');
  if (words1 === words2) return true;
  
  return false;
}