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
1. PRIMARY KEYS are UNDERLINED text - detect ALL underlines carefully
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
        model: 'google/gemini-2.5-flash-lite-preview-09-2025',
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
    // Clean markdown if present
    const cleanContent = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    // Parse JSON with error handling
    let result;
    try {
      result = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error('❌ JSON Parse Error:', parseError.message);
      console.error('Content that failed:', cleanContent);
      throw new Error('AI returned invalid JSON format');
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

**YOUR ONLY JOB:**
Generate helpful, educational feedback for the student. The scores are already calculated - you just explain them in friendly language.

**FEEDBACK FORMAT EXAMPLES:**

CORRECT section example:
- "You correctly identified Student, Course, and Professor entities"
- "The Enrolls relationship correctly connects Student and Course with many-to-many cardinality, allowing students to enroll in multiple courses"

MISSING section example:
- "Department entity - Without this, you cannot track which department each professor belongs to or organize courses by department"
- "Teaches relationship between Professor and Course - Without this, you cannot track which professors teach which courses"

INCORRECT section example:
- "The Advises relationship cardinality is one-to-one but should be one-to-many because one professor can advise multiple students"
- "The email attribute is under Course entity but should be under Student entity - email is student contact information, not course information"

**TONE GUIDELINES:**
- Write directly to student: "You correctly identified..." NOT "The student..."
- Be encouraging but honest
- Explain WHY errors matter (what functionality breaks)
- If everything is perfect: "Excellent work! All elements are correct."
- **DO NOT use phrases:** "Re-checking", "Adjusting score", "Confidence", "seems erroneous"
- **Use plain Unicode characters only:** Write "→" not "$\to$", write "×" not "$\times$"
- **No LaTeX or markdown formatting** in the feedback text itself

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
// DETERMINISTIC GRADING FUNCTION (FLEXIBLE CARDINALITY)
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

  const hasLenientNaming = rubric.criteria.some(c => 
    c.description.toLowerCase().includes('lenient') || 
    c.description.toLowerCase().includes('semantic')
  );

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
    // ENTITY MATCHING
    // ===========================
    if (categoryLower.includes('entit')) {
      const correctEntities = correctElements.filter(e => e.type === 'entity');
      const studentEntities = studentElements.filter(e => e.type === 'entity');
      
      if (!multiplierMatch) expectedCount = correctEntities.length;
      
      correctEntities.forEach(ce => {
        const match = studentEntities.find(se => {
          const nameMatch = hasLenientNaming 
            ? normalizeString(se.name) === normalizeString(ce.name)
            : se.name === ce.name;
          return nameMatch && se.subType === ce.subType;
        });
        
        if (match) {
          correctCount++;
          correctItems.push(ce.name);
        } else {
          missing.push(ce.name);
        }
      });
    }

    // ===========================
    // ATTRIBUTE MATCHING
    // ===========================
    else if (categoryLower.includes('attribute')) {
      const correctAttrs = correctElements.filter(e => e.type === 'attribute');
      const studentAttrs = studentElements.filter(e => e.type === 'attribute');
      
      if (!multiplierMatch) expectedCount = correctAttrs.length;
      
      correctAttrs.forEach(ca => {
        const match = studentAttrs.find(sa => {
          const nameMatch = hasLenientNaming 
            ? normalizeString(sa.name) === normalizeString(ca.name)
            : sa.name === ca.name;
          return nameMatch && sa.subType === ca.subType && sa.belongsTo === ca.belongsTo;
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
    // PRIMARY KEY MATCHING
    // ===========================
    else if (categoryLower.includes('primary') || categoryLower.includes('key')) {
      const correctPKs = correctElements.filter(e => e.type === 'attribute' && e.subType === 'primary_key');
      const studentPKs = studentElements.filter(e => e.type === 'attribute' && e.subType === 'primary_key');
      
      if (!multiplierMatch) expectedCount = correctPKs.length;
      
      correctPKs.forEach(cpk => {
        const match = studentPKs.find(spk => {
          const nameMatch = hasLenientNaming 
            ? normalizeString(spk.name) === normalizeString(cpk.name)
            : cpk.name === cpk.name;
          return nameMatch && spk.belongsTo === cpk.belongsTo;
        });
        
        if (match) {
          correctCount++;
          correctItems.push(`${cpk.name} (${cpk.belongsTo})`);
        } else {
          missing.push(`${cpk.name} as primary key in ${cpk.belongsTo}`);
        }
      });
    }

    // ===========================
    // RELATIONSHIP MATCHING
    // ===========================
    else if (categoryLower.includes('relationship') && !categoryLower.includes('cardinality')) {
      const correctRels = correctElements.filter(e => e.type === 'relationship');
      const studentRels = studentElements.filter(e => e.type === 'relationship');
      
      if (!multiplierMatch) expectedCount = correctRels.length;
      
      correctRels.forEach(cr => {
        const match = studentRels.find(sr => {
          const nameMatch = hasLenientNaming 
            ? normalizeString(sr.name) === normalizeString(cr.name)
            : sr.name === cr.name;
          return nameMatch && sr.from === cr.from && sr.to === cr.to;
        });
        
        if (match) {
          correctCount++;
          correctItems.push(`${cr.name} (${cr.from} → ${cr.to})`);
        } else {
          missing.push(`${cr.name} between ${cr.from} and ${cr.to}`);
        }
      });
    }

    // ===========================
    // 🔧 CARDINALITY MATCHING - AUTO-DETECT MODE
    // ===========================
    else if (categoryLower.includes('cardinality')) {
      const correctRels = correctElements.filter(e => e.type === 'relationship');
      const studentRels = studentElements.filter(e => e.type === 'relationship');
      
      // Auto-detect grading mode based on expectedCount
      const relationshipCount = correctRels.length;
      const checksPerRelationship = expectedCount / relationshipCount;
      
      console.log(`🔍 Cardinality mode detection: ${expectedCount} checks / ${relationshipCount} relationships = ${checksPerRelationship} checks per relationship`);
      
      // OPTION A: Grade as whole cardinality (from + to) = 2 checks per relationship
      if (checksPerRelationship === 2) {
        console.log('✅ Using OPTION A: Whole cardinality grading (from + to)');
        
        correctRels.forEach(cr => {
          const sr = studentRels.find(s => {
            const nameMatch = hasLenientNaming 
              ? normalizeString(s.name) === normalizeString(cr.name)
              : s.name === cr.name;
            return nameMatch;
          });
          
          if (sr) {
            // Check cardinalityFrom as whole string
            if (sr.cardinalityFrom === cr.cardinalityFrom) {
              correctCount++;
              correctItems.push(`${cr.name}.from (${cr.cardinalityFrom})`);
            } else {
              incorrect.push(`${cr.name}.cardinalityFrom: expected "${cr.cardinalityFrom}", got "${sr.cardinalityFrom}"`);
            }
            
            // Check cardinalityTo as whole string
            if (sr.cardinalityTo === cr.cardinalityTo) {
              correctCount++;
              correctItems.push(`${cr.name}.to (${cr.cardinalityTo})`);
            } else {
              incorrect.push(`${cr.name}.cardinalityTo: expected "${cr.cardinalityTo}", got "${sr.cardinalityTo}"`);
            }
          } else {
            missing.push(`${cr.name} relationship (both from and to cardinality missing)`);
          }
        });
      }
      
      // OPTION B: Grade min/max separately = 4 checks per relationship
      else if (checksPerRelationship === 4) {
        console.log('✅ Using OPTION B: Min/Max split grading');
        
        correctRels.forEach(cr => {
          const sr = studentRels.find(s => {
            const nameMatch = hasLenientNaming 
              ? normalizeString(s.name) === normalizeString(cr.name)
              : s.name === cr.name;
            return nameMatch;
          });
          
          if (sr) {
            // Split cardinalityFrom into min..max
            const [correctFromMin, correctFromMax] = (cr.cardinalityFrom || '').split('..');
            const [studentFromMin, studentFromMax] = (sr.cardinalityFrom || '').split('..');
            
            // Check FROM - Min
            if (studentFromMin === correctFromMin) {
              correctCount++;
              correctItems.push(`${cr.name}.from.min (${correctFromMin})`);
            } else {
              incorrect.push(`${cr.name}.cardinalityFrom.min: expected "${correctFromMin}", got "${studentFromMin}"`);
            }
            
            // Check FROM - Max
            if (studentFromMax === correctFromMax) {
              correctCount++;
              correctItems.push(`${cr.name}.from.max (${correctFromMax})`);
            } else {
              incorrect.push(`${cr.name}.cardinalityFrom.max: expected "${correctFromMax}", got "${studentFromMax}"`);
            }
            
            // Split cardinalityTo into min..max
            const [correctToMin, correctToMax] = (cr.cardinalityTo || '').split('..');
            const [studentToMin, studentToMax] = (sr.cardinalityTo || '').split('..');
            
            // Check TO - Min
            if (studentToMin === correctToMin) {
              correctCount++;
              correctItems.push(`${cr.name}.to.min (${correctToMin})`);
            } else {
              incorrect.push(`${cr.name}.cardinalityTo.min: expected "${correctToMin}", got "${studentToMin}"`);
            }
            
            // Check TO - Max
            if (studentToMax === correctToMax) {
              correctCount++;
              correctItems.push(`${cr.name}.to.max (${correctToMax})`);
            } else {
              incorrect.push(`${cr.name}.cardinalityTo.max: expected "${correctToMax}", got "${studentToMax}"`);
            }
          } else {
            missing.push(`${cr.name} relationship (all 4 cardinality parts missing)`);
          }
        });
      }
      
      // FALLBACK: Unexpected checks per relationship
      else {
        console.warn(`⚠️ Unexpected cardinality checks: ${checksPerRelationship} per relationship. Defaulting to Option A.`);
        
        correctRels.forEach(cr => {
          const sr = studentRels.find(s => {
            const nameMatch = hasLenientNaming 
              ? normalizeString(s.name) === normalizeString(cr.name)
              : s.name === cr.name;
            return nameMatch;
          });
          
          if (sr) {
            if (sr.cardinalityFrom === cr.cardinalityFrom) {
              correctCount++;
              correctItems.push(`${cr.name}.from (${cr.cardinalityFrom})`);
            } else {
              incorrect.push(`${cr.name}.cardinalityFrom: expected "${cr.cardinalityFrom}", got "${sr.cardinalityFrom}"`);
            }
            
            if (sr.cardinalityTo === cr.cardinalityTo) {
              correctCount++;
              correctItems.push(`${cr.name}.to (${cr.cardinalityTo})`);
            } else {
              incorrect.push(`${cr.name}.cardinalityTo: expected "${cr.cardinalityTo}", got "${sr.cardinalityTo}"`);
            }
          } else {
            missing.push(`${cr.name} relationship (both from and to cardinality missing)`);
          }
        });
      }
    }

    // Calculate multiplier if not from description
    if (!multiplierMatch && expectedCount > 0) {
      multiplier = maxPoints / expectedCount;
    }

    // Calculate earned points
    const earned = Math.min(correctCount * multiplier, maxPoints);
    
    result.breakdown.push({
      category,
      earned: parseFloat(earned.toFixed(2)),
      max: maxPoints,
      feedback: ''
    });

    result.totalScore += earned;
    result.correctElements[category] = correctItems;
    result.missingElements[category] = missing;
    result.incorrectElements[category] = incorrect;
    
    result._debug[category] = {
      calculation: `${correctCount} correct × ${multiplier.toFixed(3)} = ${earned.toFixed(2)} (max: ${maxPoints})`,
      expectedCount,
      correctCount,
      multiplier: parseFloat(multiplier.toFixed(3)),
      correctItems,
      missing,
      incorrect
    };
  });

  result.totalScore = parseFloat(result.totalScore.toFixed(2));
  return result;
}

function normalizeString(str) {
  return str.toLowerCase()
    .replace(/[_\s-]/g, '')
    .replace(/number/g, 'num')
    .replace(/id/g, '');
}