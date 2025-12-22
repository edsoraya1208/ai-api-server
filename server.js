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
        model: 'google/gemini-2.5-flash',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this ERD diagram. Return ONLY valid JSON, no markdown.

CRITICAL DETECTION RULES (MUST FOLLOW):
1. PRIMARY KEYS: Text MUST be UNDERLINED. If text has "ID" but NO underline, it is a "regular" attribute. DO NOT GUESS.
2. MULTIVALUED attributes have DOUBLE OVALS/circles - detect the double border
3. CARDINALITY must be read from BOTH sides of relationship 
   - Look for (0,M), (1,1), (0,1), (1,M) notation near EACH entity
   - OR look for M, 1, N letters near entities
   - from="EntityA" to="EntityB" means: EntityA's cardinality goes in cardinalityFrom, EntityB's in cardinalityTo
   - Example: Patient(0,M)─visit─(1,1)Doctor → from="Patient", cardinalityFrom="0..M", to="Doctor", cardinalityTo="1..1"

CARDINALITY MAPPING (based on what you see)
   - "0..M" (or 0,M) -> "0..M"
   - "1..M" (or 1,M) -> "1..M"
   - "0..1" (or 0,1) -> "0..1"
   - "1..1" (or 1,1) -> "1..1"
   - "M" alone -> "0..M"
   - "1" alone -> "0..1"
   - **MISSING / EMPTY** -> "none..none"
   - **MISSING MAX** (e.g. "0.." with no max) -> "0..none"

  **VISUAL CHECK**: 
     - If you see "0", "1", "M", or "N" touching the line -> Map it (see rules above).
     - If you see **NO TEXT**, NO numbers, and NO letters touching the line -> You MUST return "none..none".
     - **DO NOT GUESS**. Do not assume "1" or "M" just because a line exists. Empty space = "none..none".

REJECT IF (set isERD=false and provide rejectionReason):
- EERD features: (d) symbols, triangles with "d", ISA relationships, subclass/superclass hierarchies → "This is an EERD (Enhanced ERD), not a basic ERD"
- Crow's Foot notation: >< |< symbols → "This uses Crow's Foot notation, not Chen notation ERD"
- UML Class Diagram → "This is a UML Class Diagram, not an ERD"
- Flowchart → "This is a flowchart, not an ERD"
- Other diagram types → "This is not an ERD diagram"

DETECT ALL:
DETECT ALL:
1. ASSOCIATIVE ENTITIES (CRITICAL CHECK FIRST):
   - Look for a DIAMOND shape INSIDE a RECTANGLE.
   - If a diamond is enclosed in a rectangle, you MUST classify it as:
     { "type": "entity", "subType": "associative" }
   - DO NOT classify this as a "relationship". It acts as an entity.

2. ENTITIES:
   - Strong: Single Rectangle
   - Weak: Double Rectangle / Rectangle within a Rectangle

3. Attributes with correct subTypes:
   - primary_key: SINGLE UNDERLINED text only (dont assume from name)
   - multivalued: DOUBLE circle/oval border
   - derived: dashed circle/oval
   - composite: attribute connected to sub-attributes
   - foreign_key: (DOTTED LINE) key from another entity
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
- Entities: "subType" is "strong", "weak", or "associative"
- Relationships: "subType" is "strong" or "weak", MUST have "from", "to", "cardinalityFrom", "cardinalityTo"
- Attributes: MUST have "belongsTo" and "belongsToType" ("entity"/"relationship"/"attribute")
- Confidence: 95-100 crystal clear | 80-94 clear | 70-79 requires interpretation | 60-69 unclear/guessing | <60 very uncertain
- Relationships: max confidence is 88 for relationships, DON'T exceed.
- If cardinality OR attribute border unclear → max confidence 75
- If NOT an ERD: MUST include "rejectionReason" explaining what it is instead

AVOID COMMON MISTAKES:
1. If an attribute name contains "ID" but has NO physical underline, NEVER EVER RETURN AS PK.
2. If a relationship line has no visible text (min max cardinality), you MUST ALWAYS return "none..none" for cardinality.

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
          // =================================================================
          // 🛑 UPDATED PROMPT: Added "DECIMAL PRECISION" rules
          // =================================================================
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
{"isERDRubric":true,"totalPoints":32,"criteria":[{"category":"Entities","maxPoints":30.5,"description":"All entities correctly identified: 30.5 points"},{"category":"Relationships","maxPoints":1.5,"description":"Cardinality correct: 1.5 points"}],"notes":"Rubric emphasizes correct notation"}

CRITICAL RULES:
- Return ONLY valid JSON, no markdown code blocks, no extra text
- Each criterion MUST have: category, maxPoints, description
- **DECIMAL PRECISION IS MANDATORY**: If a category is worth 1.5 points, 'maxPoints' MUST be 1.5. DO NOT ROUND to 1 or 2.
- **CHECK YOUR MATH**: Ensure the sum of 'maxPoints' equals the total in the text.
- **PRESERVE FORMULAS IN DESCRIPTION**: If rubric says "0.5 x 16 = 8", include "0.5 x 16" in the description field like "Cardinality correctly identified: 0.5 x 16"
- If points not stated, estimate based on emphasis
- Extract ALL grading aspects mentioned
- Be concise but capture all important criteria`
          // =================================================================
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
    console.log('Raw AI response:', content.substring(0, 200) + '...'); 

    const cleanContent = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .replace(/\n/g, ' ')           
      .replace(/\s+/g, ' ')          
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

    // =========================================================
    // 🛑 STOP CRYING FIX: FORCE JAVASCRIPT TO DO THE MATH
    // =========================================================
    if (result.criteria && Array.isArray(result.criteria)) {
      // 1. Use JavaScript (a calculator) to sum the points exactly
      const realTotal = result.criteria.reduce((sum, item) => {
        return sum + (parseFloat(item.maxPoints) || 0);
      }, 0);

      console.log(`🧮 AI said Total: ${result.totalPoints}`);
      console.log(`✅ Actual Math is: ${realTotal}`);
      
      // 2. Overwrite the AI's guess with the real number
      result.totalPoints = realTotal; 
    }
    // =========================================================

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
       - **IF AN ITEM HAS A NOTE**: If the input says "Car (Note: You wrote 'Cars')", you **MUST** print that full text.
    
   2. **Concise Educational Explanations (The "Smart" Part)**:
       - **Primary Keys**: 
         - **Rule**: Must be a **Single Oval** with **Solid Underlined Text**.
         - **Explanation**: If missing, explain that the underline signifies the attribute is the **Unique Identifier** and cannot be null.
       
       - **Multivalued Attributes**: 
         - **Rule**: Must be a **Double Oval**.
         - **Explanation**: Explain that the attribute (e.g., "Phone") logically allows multiple entries for one entity (e.g. "A person can have multiple phone numbers")
       
       - **Derived Attributes**: 
         - **Rule**: Must be a **Dashed Oval**.
         - **Explanation**: Mention it is calculated from another attribute (look at the 'Correct' list to infer which one, e.g., "duration is likely derived from pickup_date and return_date").

       - **Foreign Keys**: 
         - **Rule**: Dashed underline (if that's the error). Explain it links to another entity's Primary Key.

   3. **✅ HUMAN VARIATION (CRITICAL)**:
       - **NO ROBOTIC REPETITION**: If the student makes the *same* mistake twice (e.g., 2 Primary Keys not underlined), **DO NOT** use the exact same sentence.
       - **First Instance**: Explain the concept fully (e.g., "VehicleID needs an underline to show it is the unique identifier.").
       - **Second Instance**: Be briefer or vary the wording (e.g., "Similarly, DriverID is a primary key and requires standard underlining notation.").
       - **Make it flow**: Read the errors like a human grading a paper, not a machine printing a log.

   4. **✅ SMART CARDINALITY & BUSINESS LOGIC**:
       - **Context**: If the error includes "(between Entity A & Entity B)", use those names!
       - **Logic**:
         - If Exp: 0, Found: 1 -> Explain **Optionality** ("A [Entity A] does not *need* to have a [Entity B]...").
         - If Exp: 1, Found: 0 -> Explain **Mandatory Existence** ("A [Entity A] *must* be associated with at least one [Entity B]...").
         - If Exp: 1, Found: M -> Explain **Uniqueness** ("A [Entity A] can only have *one* [Entity B], not many.").
         
  5. **✅ EXTRA ELEMENTS LOGIC**:
       - **Decide Relevance**: Check if the extra element makes sense in the real world alongside the Correct Entities.
       - **If Logical but Out of Scope**: Say: "While logical in a real-world scenario, the scope of this exercise is limited to tracking [Main Entities from Correct List], so this element is excluded for simplicity."
       - **If Irrelevant or Redundant**: Say: "This element is not required unless explicitly specified in the question."
       - **Incorrect Types**: Explain shape errors (e.g. "Diamond is for relationships, Rectangle is for entities").

    6. **SAFETY GUARDRAIL**:
       - **DO NOT** invent business rules. Use phrases like "This implies..."
       - **Tone**: Encouraging but direct.
    
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
        model: 'google/gemini-2.5-flash',
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
    const categoryLower = category.toLowerCase();

    // 1. Extract Multipliers (e.g., "0.5 x 4")
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

    // ===========================
    // A. ENTITY MATCHING
    // ===========================
    if (categoryLower.includes('entit')) {
      // ✅ SMART CHANGE 1: Use Filter to handle "Weak Entities" vs "Entities"
      const targetCorrectElements = filterElementsByContext(correctElements, 'entity', categoryLower);
      const studentEntities = studentElements.filter(e => e.type === 'entity');
      
      // If rubric didn't say "x 4", calculate expected count based on our filtered list
      if (!multiplierMatch) expectedCount = targetCorrectElements.length;
      
      targetCorrectElements.forEach(ce => {
        // 1. Find Name Match
        const match = studentEntities.find(se => 
           areStringsSemanticallySimilar(se.name, ce.name)
        );
        
        if (match) {
          // 2. STRICT TYPE CHECK
          if (match.subType !== ce.subType) {
              // WRONG SHAPE = NO POINTS
              incorrect.push(`${ce.name} (Incorrect Type: You used '${match.subType}', expected '${ce.subType}')`);
              matchedStudentIds.add(match.id); 
          } else {
              // CORRECT SHAPE = POINTS
              correctCount++;
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
    }

    // ===========================
    // B. ATTRIBUTE & KEY MATCHING (SMART HYBRID)
    // ===========================
    else if (categoryLower.includes('attribute') || categoryLower.includes('key')) {
      const targetCorrectElements = filterElementsByContext(correctElements, 'attribute', categoryLower);
      const studentAttrs = studentElements.filter(e => e.type === 'attribute');
      
      // 1. DYNAMIC STRICT MODE CHECK
      // If the rubric category title mentions a specific type, we enforce STRICT shape matching.
      // If it's just "Attributes", we are LENIENT (name match only).
      const isSpecificSection = categoryLower.includes('primary') || 
                                categoryLower.includes('key') || 
                                categoryLower.includes('derived') ||
                                categoryLower.includes('composite') ||
                                categoryLower.includes('multi'); // Covers 'multivalued'
      
      if (!multiplierMatch) expectedCount = targetCorrectElements.length;
      
      targetCorrectElements.forEach(ca => {
        const match = studentAttrs.find(sa => {
          const nameMatch = areStringsSemanticallySimilar(sa.name, ca.name);
          const mappedParent = entityMap[sa.belongsTo] || sa.belongsTo;
          const parentMatch = areStringsSemanticallySimilar(mappedParent, ca.belongsTo);
          return nameMatch && parentMatch;
        });
        
        if (match) {
          // LOGIC: Check if the shape (subtype) is correct
          const isShapeWrong = match.subType !== ca.subType;

          if (isSpecificSection && isShapeWrong) {
             // STRICT MODE: If grading a specific type (e.g. PK), wrong shape = 0 points.
             let errorMsg = `${ca.name} (Incorrect Notation: You used '${match.subType}', expected '${ca.subType}')`;
             
             // Friendly error messages
             if (ca.subType === 'primary_key') errorMsg = `${ca.name} is a Primary Key but was not underlined.`;
             if (ca.subType === 'multivalued') errorMsg = `${ca.name} is Multivalued but missing double oval.`;
             if (ca.subType === 'derived') errorMsg = `${ca.name} is Derived but missing dashed oval.`;

             incorrect.push(errorMsg);
             matchedStudentIds.add(match.id);
          } else {
             // LENIENT MODE: If grading general "Attributes", we give points even if shape is wrong
             // (because the penalty is applied in the specific section above/below).
             correctCount++;
             
             let note = "";
             if (match.name !== ca.name) note += ` (Note: You wrote '${match.name}')`;
             
             correctItems.push(ca.name + note);
             matchedStudentIds.add(match.id);
          }
        } else {
          missing.push(`${ca.name} in ${ca.belongsTo}`);
        }
      });
    }

    // ===========================
    // C. RELATIONSHIP MATCHING
    // ===========================
    else if (categoryLower.includes('relationship') && !categoryLower.includes('cardinality')) {
      const targetCorrectElements = filterElementsByContext(correctElements, 'relationship', categoryLower);
      const studentRels = studentElements.filter(e => e.type === 'relationship');
      
      if (!multiplierMatch) expectedCount = targetCorrectElements.length;
      
      targetCorrectElements.forEach(cr => {
        const match = studentRels.find(sr => {
           const sFrom = entityMap[sr.from] || sr.from;
           const sTo = entityMap[sr.to] || sr.to;
           const forward = areStringsSemanticallySimilar(sFrom, cr.from) && areStringsSemanticallySimilar(sTo, cr.to);
           const reverse = areStringsSemanticallySimilar(sFrom, cr.to) && areStringsSemanticallySimilar(sTo, cr.from);
           const nameMatch = areStringsSemanticallySimilar(sr.name, cr.name);
           return (forward || reverse) || (nameMatch && (forward || reverse));
        });
        
        if (match) {
          if (match.subType !== cr.subType) {
             incorrect.push(`${cr.name} (Incorrect Type: You used '${match.subType}' diamond, expected '${cr.subType}')`);
          } else {
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
      
      // Mark extras (only if we haven't seen them yet)
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

                if (areStringsSemanticallySimilar(sFromMin, cFromMin)) { 
                    correctCount++; 
                    correctItems.push(`${cr.name} start-min`); 
                } else {
                    incorrect.push(`${cr.name} (between ${cr.from} & ${cr.to}) towards ${cr.from} min-cardinality (Exp:${cFromMin} Found:${sFromMin})`);
                }

                if (areStringsSemanticallySimilar(sFromMax, cFromMax)) { 
                    correctCount++; 
                    correctItems.push(`${cr.name} start-max`); 
                } else {
                    incorrect.push(`${cr.name} (between ${cr.from} & ${cr.to}) towards ${cr.from} max-cardinality (Exp:${cFromMax} Found:${sFromMax})`);
                }

                if (areStringsSemanticallySimilar(sToMin, cToMin)) { 
                    correctCount++; 
                    correctItems.push(`${cr.name} end-min`); 
                } else {
                    incorrect.push(`${cr.name} (between ${cr.from} & ${cr.to}) towards ${cr.to} min-cardinality (Exp:${cToMin} Found:${sToMin})`);
                }

                if (areStringsSemanticallySimilar(sToMax, cToMax)) { 
                    correctCount++; 
                    correctItems.push(`${cr.name} end-max`); 
                } else {
                    incorrect.push(`${cr.name} (between ${cr.from} & ${cr.to}) towards ${cr.to} max-cardinality (Exp:${cToMax} Found:${sToMax})`);
                }
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

// ===========================
// HELPER FUNCTIONS
// ===========================

// 🆕 SMART HELPER: Selects which elements to grade based on the Rubric Row name
function filterElementsByContext(elements, type, context) {
  const ctx = context.toLowerCase();
  
  // 1. Get all items of the right type (e.g. all Attributes)
  let filtered = elements.filter(e => e.type === type);

  // 2. SAFETY CHECK: If the rubric is asking for a SPECIFIC subtype, filter for it.
  
  // --- ATTRIBUTE FILTERS (Unchanged) ---
  if (type === 'attribute') {
    if (ctx.includes('multi')) return filtered.filter(e => e.subType === 'multivalued');
    if (ctx.includes('composite')) return filtered.filter(e => e.subType === 'composite');
    if (ctx.includes('derived')) return filtered.filter(e => e.subType === 'derived');
    if (ctx.includes('primary') || ctx.includes('identifier') || ctx.includes('key')) {
        return filtered.filter(e => e.subType === 'primary_key');
    }
    return filtered; // Return ALL if generic
  }

  // --- ENTITY FILTERS (Unchanged) ---
  if (type === 'entity') {
    if (ctx.includes('weak')) return filtered.filter(e => e.subType === 'weak');
    if (ctx.includes('associative')) return filtered.filter(e => e.subType === 'associative');
    return filtered; // Return ALL if generic
  } 

  // --- RELATIONSHIP FILTERS (✅ NEW ADDITION) ---
  if (type === 'relationship') {
      // If rubric says "Weak Relationship" or "Identifying Relationship"
      if (ctx.includes('weak') || ctx.includes('identifying')) {
          return filtered.filter(e => e.subType === 'weak');
      }
      // If rubric says "Associative" (sometimes people call the relationship associative)
      if (ctx.includes('associative')) {
           return filtered.filter(e => e.subType === 'associative');
      }
      
      return filtered; // Return ALL if generic "Relationships"
  }

  return filtered;
}

// HELPER: Fuzzy String Matcher (The "Smart Bouncer")
function areStringsSemanticallySimilar(str1, str2) {
  if (!str1 || !str2) return false;
  
  // 1. Clean them up (lowercase, remove spaces/underscores)
  const s1 = str1.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

  // 2. Exact Match
  if (s1 === s2) return true;

  // 3. The "Lazy Substring" Fix
  if (s1.includes(s2) && s2.length > 3) return true;
  if (s2.includes(s1) && s1.length > 3) return true;

  // 4. Plurals/Stemming
  const MIN_LEN = 3; 
  if (s1.length >= MIN_LEN && s2.length >= MIN_LEN) {
    if (s1 === s2 + 's' || s2 === s1 + 's') return true;
    if (s1 === s2 + 'es' || s2 === s1 + 'es') return true;
    if (s1.endsWith('ed') && s1.slice(0, -2) === s2) return true;
    if (s2.endsWith('ed') && s2.slice(0, -2) === s1) return true;
  }

  // 5. Word Bag
  const words1 = str1.toLowerCase().split(/[\s_]+/).sort().join('');
  const words2 = str2.toLowerCase().split(/[\s_]+/).sort().join('');
  if (words1 === words2) return true;

  // 6. Typo Fix (Levenshtein)
  const len = Math.max(s1.length, s2.length);
  const allowedErrors = len > 6 ? 2 : (len > 3 ? 1 : 0);

  if (allowedErrors > 0) {
    const dist = getLevenshteinDistance(s1, s2);
    if (dist <= allowedErrors) return true;
  }

  return false;
}

// HELPER: Levenshtein Distance
function getLevenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}