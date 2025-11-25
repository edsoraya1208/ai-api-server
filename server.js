import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Allow requests from your Vercel app
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://erducate.vercel.app'
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
3. CARDINALITY must be read from BOTH sides of relationship:
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
- Relationships: max confidence 88 (cardinality requires careful reading)
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
✅ Grading criteria/descriptions
✅ Total marks
❌ OUT OF SCOPE (reject if found):
- Rubrics for SQL queries, normalization, or non-ERD topics
- Completely unreadable/corrupted text
- Non-grading content
IF NOT AN ERD RUBRIC:
{"isERDRubric":false,"reason":"This rubric is for SQL queries, not ERD diagrams"}
IF IS AN ERD RUBRIC:
{"isERDRubric":true,"totalPoints":100,"criteria":[{"category":"Entities","maxPoints":30,"description":"All entities correctly identified with proper notation"},{"category":"Relationships","maxPoints":30,"description":"Cardinality correct. Relationship names meaningful."}],"notes":"Rubric emphasizes correct notation"}
CRITICAL RULES:
- Return ONLY valid JSON, no markdown code blocks, no extra text
- Each criterion MUST have: category, maxPoints, description
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

// 🆕 Auto-grading endpoint
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

    // Build comprehensive comparison prompt
    const prompt = `You are a STRICT ERD grading assistant.

**CORRECT ANSWER:**
${JSON.stringify(correctAnswer.elements, null, 2)}

**STUDENT SUBMISSION:**
${JSON.stringify(studentElements, null, 2)}

${rubricStructured ? `**RUBRIC:**
Total: ${rubricStructured.totalPoints} points
${rubricStructured.criteria.map(c => `- ${c.category}: ${c.maxPoints} pts - ${c.description}`).join('\n')}
` : '**No rubric. Use standard ERD criteria.**'}

---
**GRADING STEPS:**

STEP 1: COUNT CORRECT ANSWER ELEMENTS
- Entities: [count]
- Attributes: [count] 
- Primary Keys: [count subType="primary_key"]
- Relationships: [count]
- Cardinality items: [number after "x" in rubric]

STEP 2: DETERMINE CARDINALITY MODE
Ratio = (Cardinality items) ÷ (Relationships count)
- If Ratio > 3 → COMPONENT MODE (4 per relationship: from-min, from-max, to-min, to-max)
- If Ratio ≤ 3 → ENDPOINT MODE (2 per relationship: from-tag, to-tag)

STEP 3: MATCH ELEMENTS (ONE BY ONE)
**Entities:** name match ${rubricStructured?.criteria.find(c => c.category.toLowerCase().includes('entit'))?.description.toLowerCase().includes('lenient') ? '(lenient: "phone" = "phone_number")' : '(STRICT: exact match)'}
**Attributes:** name + belongsTo match ${rubricStructured?.criteria.find(c => c.category.toLowerCase().includes('attrib'))?.description.toLowerCase().includes('lenient') ? '(lenient naming)' : '(STRICT: exact match)'}
**Primary Keys:** subType="primary_key" (STRICT - don't assume from name)
**Relationships:** name + from + to ${rubricStructured?.criteria.find(c => c.category.toLowerCase().includes('relation'))?.description.toLowerCase().includes('lenient') ? '(lenient naming, ignore array order)' : '(STRICT: exact match)'}
**Cardinality:**
  COMPONENT MODE: Split "0..M" into min="0" and max="M". Compare EACH separately.
    Example: Student "1..M" vs Correct "0..M" → 1 match (max="M"), 1 wrong (min) → Count = 1
  ENDPOINT MODE: Match ENTIRE tag. "0..M" ≠ "1..M" → Count = 0

STEP 4: CALCULATE SCORES
Extract multiplier from rubric (e.g., "0.5 x 16" → multiplier = 0.5)
- Entities: (correct count) × (multiplier) = earned
- Attributes: (correct count) × (multiplier) = earned  
- Primary Keys: (correct count) × (multiplier) = earned
- Relationships: (correct count) × (multiplier) = earned
- Cardinality: (correct items from Step 3) × (multiplier) = earned

STEP 5: WRITE FEEDBACK
Base ONLY on Step 3 findings. Do NOT hallucinate.
Tone: "You correctly identified..." (NOT "The student...")
If perfect: "Excellent work! All elements correct."
NO phrases: "Re-checking", "Adjusting", "Confidence"

---
**OUTPUT (VALID JSON ONLY):**
{
  "totalScore": [sum earned],
  "maxScore": ${rubricStructured?.totalPoints || 100},
  "breakdown": [
    {"category": "Entities", "earned": [calc], "max": [rubric], "feedback": "[matches/mismatches]"},
    {"category": "Attributes", "earned": [calc], "max": [rubric], "feedback": "[matches/mismatches]"},
    {"category": "Primary Keys", "earned": [calc], "max": [rubric], "feedback": "[matches/mismatches]"},
    {"category": "Relationships", "earned": [calc], "max": [rubric], "feedback": "[matches/mismatches]"},
    {"category": "Cardinality", "earned": [calc], "max": [rubric], "feedback": "[specific relationship names + what's wrong]"}
  ],
  "feedback": {
    "correct": ["[what student got right - helpful for review]"],
    "missing": ["[what's absent from correct answer, e.g., 'Department entity - needed to track professor departments']"],
    "incorrect": ["[what's wrong vs correct answer, e.g., 'Advises cardinality is 1..1 but should be 1..M']"]
  },
  "overallComment": "[2-3 sentence summary]"
}

**CRITICAL RULES:**
1. Return ONLY valid JSON (no markdown, no extra text)
2. Scores MUST match Step 4 calculations exactly
3. Feedback MUST match Step 3 findings (no hallucinations)
4. Cardinality: In Component Mode, count each min/max separately. In Endpoint Mode, count exact matches only.
5. If rubric mentions "lenient" for a category, allow name variations (e.g., "phone" = "phone_number") but still mark in feedback
6. Empty arrays = [], never null
7. Write to student directly
`;
    // Call OpenRouter AI
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
          content: prompt
        }],
        temperature: 0.2, // Lower temp for consistent grading
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
    const cleanContent = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    // 🔍 DEBUG LOGGING - See what AI actually returned
    console.log('📊 Raw AI response (first 500 chars):', cleanContent.substring(0, 500));

    let result;
    try {
      result = JSON.parse(cleanContent);
      
      // 🔍 DEBUG LOGGING - See parsed structure
      console.log('📊 Parsed structure:', JSON.stringify(result, null, 2));
      console.log('  - Has totalScore?', typeof result.totalScore, '=', result.totalScore);
      console.log('  - Has breakdown?', Array.isArray(result.breakdown), '=', result.breakdown?.length);
      console.log('  - Has feedback?', typeof result.feedback, '=', Object.keys(result.feedback || {}).length);
      
    } catch (parseError) {
      console.error('❌ JSON Parse Error:', parseError.message);
      console.error('Content that failed to parse:', cleanContent);
      throw new Error('AI returned invalid JSON format');
    }

    // Validate result structure (improved validation)
    if (typeof result.totalScore === 'undefined' || 
        !Array.isArray(result.breakdown) || 
        typeof result.feedback !== 'object') {
      console.error('❌ Validation failed. Missing fields:', {
        hasTotalScore: typeof result.totalScore !== 'undefined',
        hasBreakdown: Array.isArray(result.breakdown),
        hasFeedback: typeof result.feedback === 'object'
      });
      throw new Error('AI response missing required fields');
    }

    console.log('✅ Auto-grading complete:', result.totalScore, '/', result.maxScore);
    return res.status(200).json(result);

  } catch (error) {
    console.error('❌ Auto-grading error:', error);
    
    return res.status(500).json({ 
      error: 'Auto-grading failed',
      message: error.message
    });
  }
});