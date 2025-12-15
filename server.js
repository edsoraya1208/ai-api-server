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

REJECT IF (set isERD=false and provide rejectionReason):
- EERD features: (d) symbols, triangles with "d", ISA relationships, subclass/superclass hierarchies → "This is an EERD (Enhanced ERD), not a basic ERD"
- Crow's Foot notation: >< |< symbols → "This uses Crow's Foot notation, not Chen notation ERD"
- UML Class Diagram → "This is a UML Class Diagram, not an ERD"
- Flowchart → "This is a flowchart, not an ERD"
- Other diagram types → "This is not an ERD diagram"

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

RESPONSE FORMAT FOR ERD:
{
  "isERD": true,
  "elements": [
    {"id": "el_1", "name": "Patient", "type": "entity", "subType": "strong", "confidence": 95},
    {"id": "el_2", "name": "visit", "type": "relationship", "subType": "strong", "from": "Patient", "to": "Doctor", "cardinalityFrom": "0..M", "cardinalityTo": "1..1", "confidence": 88},
    {"id": "el_3", "name": "PatientID", "type": "attribute", "subType": "primary_key", "belongsTo": "Patient", "belongsToType": "entity", "confidence": 92}
  ]
}

RESPONSE FORMAT FOR NON-ERD:
{
  "isERD": false,
  "rejectionReason": "This is an EERD (Enhanced ERD), not a basic ERD"
}

REQUIRED FIELDS:
- Each element: unique "id" (el_1, el_2...)
- Entities: "subType" is "strong" or "weak"
- Relationships: "subType" is "strong" or "weak", MUST have "from", "to", "cardinalityFrom", "cardinalityTo"
- Attributes: MUST have "belongsTo" and "belongsToType" ("entity"/"relationship"/"attribute")
- Confidence: 95-100 crystal clear | 80-94 clear | 70-79 requires interpretation | 60-69 unclear/guessing | <60 very uncertain
- Relationships: max confidence is 88 for relationships, DON'T exceed.
- If cardinality OR attribute border unclear → max confidence 75
- If NOT an ERD: MUST include "rejectionReason" explaining what it is instead

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
    // STEP 2: AI GENERATES FEEDBACK ONLY (SAFE MODE)
    // ===========================
    const prompt = `You are an expert Database Professor grading an ERD.
    
    INPUT DATA:
    Total Score: ${grading.totalScore} / ${grading.maxScore}
    
    ITEMS MARKED CORRECT:
    ${JSON.stringify(grading.correctElements)}
    
    ITEMS MARKED MISSING:
    ${JSON.stringify(grading.missingElements)}

    ITEMS MARKED INCORRECT:
    ${JSON.stringify(grading.incorrectElements)}
    
    CRITICAL INSTRUCTIONS:
    1. **Grouping**: 
       - In the "correct" list, group simple items by category on one line.
       - **IF AN ITEM HAS A NOTE**: If the input says "Car (Note: You wrote 'Cars')", you **MUST** print that full text. **DO NOT** remove the note to make it look "clean".
       - Example Output: "Entities: CUSTOMER, RENTAL, CAR (Note: You wrote 'Cars')"
    
   2. **Concise Educational Explanations**:
       - You MUST explain the database concept, but keep it to **MAXIMUM 2 SENTENCES**.
       
       - **Derived Attributes**: Briefly explain they are calculated from other data and must use dashed ovals.
       - **Multivalued**: Briefly mention single ovals cannot hold multiple values.
       - **Style**: Be helpful and specific, but do NOT write full paragraphs or general definitions.

       ✅ SMART CARDINALITY LOGIC:
       - **Cardinality**: Look at the Entity name in the error (e.g., "towards Patient"). Explain the logic using that specific entity.
         - If Exp: 0, Found: 1 -> "Expected 0 (Optional): A [Other Entity] can exist without a [Target Entity]."
         - If Exp: 1, Found: 0 -> "Expected 1 (Mandatory): A [Other Entity] must have at least one [Target Entity] to exist."

       ✅ EXTRA ELEMENTS LOGIC (REQUIRED TO SHOW EXTRAS):
       - **Extra/Unexpected Elements**: If the 'ITEMS MARKED INCORRECT' list contains "Extra", "Unexpected", or "Incorrect Type", you MUST include them in the output. 
         - For "Extra": Feedback: "This element is not part of the solution requirements."
         - For "Incorrect Type": Explain why the shape used is wrong (e.g. "Diamond is for relationships").

    3. **SAFETY GUARDRAIL**:
       - **DO NOT** invent business rules.
       - Use phrases like "This implies..." rather than "The requirements stated...".

    4. **Tone**: Encouraging but direct.
    
    OUTPUT JSON FORMAT (Must match exactly):
    {
      "breakdown": [
        { "category": "Entities", "feedback": "Brief feedback..." }
      ],
      "feedback": {
        "correct": ["List of strengths"],
        "missing": ["List of missing items"],
        "incorrect": ["List of errors with 1-2 sentence educational explanation"]
      },
      "overallComment": "Summary comment."
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
// DETERMINISTIC GRADING FUNCTION (STRICT SHAPE / LENIENT NAME)
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

  const matchedStudentIds = new Set();
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
        // 1. Find Name Match
        const match = studentEntities.find(se => 
           areStringsSemanticallySimilar(se.name, ce.name)
        );
        
        if (match) {
          // 2. STRICT TYPE CHECK
          if (match.subType !== ce.subType) {
              // WRONG SHAPE = NO POINTS
              incorrect.push(`${ce.name} (Incorrect Type: You used '${match.subType}', expected '${ce.subType}')`);
              matchedStudentIds.add(match.id); // Mark as seen so it doesn't show as "Extra"
          } else {
              // CORRECT SHAPE = POINTS
              correctCount++;
              // Lenient Naming Check
              if (match.name !== ce.name) {
                 correctItems.push(`${ce.name} (Note: You wrote '${match.name}')`);
              } else {
                 correctItems.push(ce.name);
              }
              entityMap[match.name] = ce.name;
              matchedStudentIds.add(match.id);
          }
        } else {
          missing.push(ce.name);
        }
      });

      // Find Extras
      studentEntities.forEach(se => {
          if (!matchedStudentIds.has(se.id)) {
              incorrect.push(`Extra/Incorrect Entity: ${se.name}`);
          }
      });
    }

    // ===========================
    // B. ATTRIBUTE & KEY MATCHING (STRICT DERIVED CHECK)
    // ===========================
    else if (categoryLower.includes('attribute') || categoryLower.includes('key')) {
      const isPK = categoryLower.includes('primary') || categoryLower.includes('key');
      const targetSubType = isPK ? 'primary_key' : null;

      // Filter lists based on what we are currently grading (Attributes vs PKs)
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
          // STRICT TYPE CHECK (Ignore for PKs as they are filtered by category already)
          if (!isPK && match.subType !== ca.subType) {
             // WRONG SHAPE = NO POINTS
             incorrect.push(`${ca.name} (Incorrect Type: You used '${match.subType}' oval, expected '${ca.subType}' oval)`);
          } else {
             // CORRECT SHAPE = POINTS
             correctCount++;
             if (match.name !== ca.name) {
                correctItems.push(`${ca.name} (Note: '${match.name}')`);
             } else {
                correctItems.push(ca.name);
             }
          }
          matchedStudentIds.add(match.id);
        } else {
          missing.push(`${ca.name} in ${ca.belongsTo}`);
        }
      });

      // Find Extras
      studentAttrs.forEach(sa => {
          if (!matchedStudentIds.has(sa.id)) {
              incorrect.push(`Unexpected attribute: '${sa.name}' in ${sa.belongsTo}`);
          }
      });
    }

    // ===========================
    // C. RELATIONSHIP MATCHING
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
          // STRICT TYPE CHECK (Weak vs Strong Diamond)
          if (match.subType !== cr.subType) {
             // WRONG SHAPE = NO POINTS
             incorrect.push(`${cr.name} (Incorrect Type: You used '${match.subType}' diamond, expected '${cr.subType}')`);
          } else {
             // CORRECT
             correctCount++;
             if (match.name !== cr.name) {
                correctItems.push(`${cr.name} (Note: '${match.name}')`);
             } else {
                correctItems.push(cr.name);
             }
          }
          matchedStudentIds.add(match.id);
        } else {
          missing.push(`${cr.name} between ${cr.from} and ${cr.to}`);
        }
      });
      
      studentRels.forEach(sr => {
          if (!matchedStudentIds.has(sr.id)) {
              incorrect.push(`Extra relationship: ${sr.name}`);
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

                // ✅ UPDATE 1: Add context to error messages so AI understands them
                if (areStringsSemanticallySimilar(sFromMin, cFromMin)) { correctCount++; correctItems.push(`${cr.name} start-min`); }
                else incorrect.push(`${cr.name} (towards ${cr.from}) min-cardinality (Exp:${cFromMin} Found:${sFromMin})`);

                if (areStringsSemanticallySimilar(sFromMax, cFromMax)) { correctCount++; correctItems.push(`${cr.name} start-max`); }
                else incorrect.push(`${cr.name} (towards ${cr.from}) max-cardinality (Exp:${cFromMax} Found:${sFromMax})`);

                if (areStringsSemanticallySimilar(sToMin, cToMin)) { correctCount++; correctItems.push(`${cr.name} end-min`); }
                else incorrect.push(`${cr.name} (towards ${cr.to}) min-cardinality (Exp:${cToMin} Found:${sToMin})`);

                if (areStringsSemanticallySimilar(sToMax, cToMax)) { correctCount++; correctItems.push(`${cr.name} end-max`); }
                else incorrect.push(`${cr.name} (towards ${cr.to}) max-cardinality (Exp:${cToMax} Found:${sToMax})`);

            } else {
               if ((studentFromVal || '').includes(cr.cardinalityFrom) || (cr.cardinalityFrom || '').includes(studentFromVal)) {
                   correctCount++; correctItems.push(`${cr.name} start`);
               } else {
                   incorrect.push(`${cr.name} start (Exp:${cr.cardinalityFrom} Found:${studentFromVal})`);
               }
               
               if ((studentToVal || '').includes(cr.cardinalityTo) || (cr.cardinalityTo || '').includes(studentToVal)) {
                   correctCount++; correctItems.push(`${cr.name} end`);
               } else {
                   incorrect.push(`${cr.name} end (Exp:${cr.cardinalityTo} Found:${studentToVal})`);
               }
            }
         } else {
             missing.push(`Cardinality for ${cr.name}`);
         }
      });
    }

    if (!multiplierMatch && expectedCount > 0) multiplier = maxPoints / expectedCount;
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
    
    result._debug[category] = { expectedCount, correctCount, multiplier, missing, incorrect };
  });

  result.totalScore = parseFloat(result.totalScore.toFixed(2));
  return result;
}

// HELPER: Fuzzy String Matcher (Professional "Stemming" Version)
function areStringsSemanticallySimilar(str1, str2) {
  if (!str1 || !str2) return false;
  
  // 1. Clean them up (lowercase, remove spaces/underscores)
  const s1 = str1.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

  // 2. Exact Match (The Old Way - THIS RUNS FIRST, so it's safe!)
  if (s1 === s2) return true;

  // 3. The "Plural Fix" (Stemming)
  // Logic: "Is one word just the other word + s?"
  // We use >= 3 so it works for "CAR" (length 3) but skips "IS" (length 2)
  const MIN_LEN = 3; 

  if (s1.length >= MIN_LEN && s2.length >= MIN_LEN) {
    if (s1 === s2 + 's') return true;  // car == cars
    if (s2 === s1 + 's') return true;  // cars == car
    if (s1 === s2 + 'es') return true; // bus == buses
    if (s2 === s1 + 'es') return true; // buses == bus
  }

  // 4. The "Past Tense Fix" (Stemming for Verbs)
  // Logic: "Is one word just the other word + ed or d?"
  if (s1.length >= MIN_LEN && s2.length >= MIN_LEN) {
    // Check for 'ed' suffix (assign vs assigned)
    if (s1.endsWith('ed') && s1.slice(0, -2) === s2) return true;
    if (s2.endsWith('ed') && s2.slice(0, -2) === s1) return true;
    
    // Check for 'd' suffix (use vs used)
    if (s1.endsWith('d') && s1.slice(0, -1) === s2) return true;
    if (s2.endsWith('d') && s2.slice(0, -1) === s1) return true;
  }

  // 5. Word Bag (Handles "Driver ID" vs "ID Driver")
  const words1 = str1.toLowerCase().split(/[\s_]+/).sort().join('');
  const words2 = str2.toLowerCase().split(/[\s_]+/).sort().join('');
  if (words1 === words2) return true;

  return false;
}