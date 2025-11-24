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
   - primary_key: UNDERLINED text
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

    **CORRECT ANSWER (What lecturer expects):**
    ${JSON.stringify(correctAnswer.elements, null, 2)}

    **STUDENT'S SUBMISSION:**
    ${JSON.stringify(studentElements, null, 2)}

    ${rubricStructured ? `**GRADING RUBRIC:**
    Total Points: ${rubricStructured.totalPoints}
    Criteria:
    ${rubricStructured.criteria.map(c => `- ${c.category}: ${c.maxPoints} points - ${c.description}`).join('\n')}
    ` : '**No rubric provided. Use standard ERD grading criteria.**'}

    **YOUR TASK:**
    1. FIRST: Check if student's ERD is the same domain as correct answer
      ⚠️ If COMPLETELY DIFFERENT DOMAIN (e.g., University vs Hospital), award 0 points immediately
      Example: Correct="Student, Course, Professor" but student="Patient, Doctor, Hospital" → Score: 0/100
      Feedback: "Your ERD is for a completely different domain. This assignment requires a University ERD, but you submitted a Hospital ERD."

    2. Compare ONLY the detected elements from student submission vs correct answer scheme element by element
      - Grade based on what's DETECTED in the elements arrays, not assumptions
      - Use element NAMES only in feedback (never mention el_1, el_2, etc.)

    3. STRICTLY follow the rubric criteria and point allocations:
      - Award points per category based on correct matches
      - Deduct from category points when elements differ
      - Do NOT make up your own scoring

    4. **CARDINALITY SCORING:**
      - IMPORTANT: Use rubric multiplier (e.g., 0.5 x 16). Even 1 wrong cardinality component = deduct points, NOT full marks
      - Compare each relationship's cardinality component by component
      - Calculate: Points per component = (Cardinality max points) ÷ (Total cardinality components in correct answer)
      - For EACH wrong component: Deduct (Points per component) from Cardinality earned
      - **CRITICAL: If ANY cardinality differs from correct answer, Cardinality earned MUST be less than Cardinality max**
      - Example: 8 points for Cardinality, 16 total components → 0.5 per component
        * Correct="1..M", Student="0..M" → 1 wrong component → deduct 0.5 → Score: 7.5/8
      - **NEVER award full Cardinality points if you detect ANY cardinality mismatch in feedback**

    **FEEDBACK TONE:**
    - Write directly to student: "You correctly identified..." NOT "The student correctly identified..."
    - Be concise, no self-corrections or recalculations in the feedback text
    - If everything is perfect, just say: "Excellent work! All elements are correct."
    - Do NOT include phrases like "Re-checking", "seems erroneous", "Adjusting score" in the feedback

    **RETURN FORMAT:**
    Return ONLY valid JSON, no markdown code blocks, no extra text.

    {
      "totalScore": 85,
      "maxScore": ${rubricStructured?.totalPoints || 100},
      "breakdown": [
        {"category": "Entities", "earned": 25, "max": 30, "feedback": "You correctly identified Student, Course, and Professor entities. However, you are missing the Department entity which is needed to organize professors by their departments."},
        {"category": "Relationships", "earned": 20, "max": 30, "feedback": "The Enrolls relationship between Student and Course is correct with many-to-many cardinality. However, the Advises relationship should be one-to-many (one professor advises multiple students) but you set it as one-to-one. You are also missing the Teaches relationship between Professor and Course."},
        {"category": "Attributes", "earned": 32, "max": 40, "feedback": "Most attributes are placed correctly. However, the email attribute belongs to the Student entity, not the Course entity. Without this correction, you cannot store student contact information properly. Also missing primary key designation for StudentID in the Student entity."}
      ],
      "feedback": {
        "correct": [
          "All three main entities (Student, Course, Professor) are correctly identified",
          "The Enrolls relationship correctly connects Student and Course with many-to-many cardinality, allowing students to enroll in multiple courses and courses to have multiple students"
        ],
        "missing": [
          "Department entity - Without this, you cannot track which department each professor belongs to or organize courses by department",
          "Teaches relationship between Professor and Course - Without this, you cannot track which professors teach which courses"
        ],
        "incorrect": [
          "The Advises relationship cardinality is one-to-one but should be one-to-many because one professor can advise multiple students",
          "The email attribute is under Course entity but should be under Student entity - email is student contact information, not course information"
        ]
      },
      "overallComment": "Your ERD demonstrates good understanding of the core structure with all main entities present. Key improvements needed: add the Department entity to track professor organization, correct the Advises relationship to one-to-many cardinality, and move the email attribute to the Student entity where it belongs."
    }

    **CRITICAL RULES:**
    - Return ONLY valid JSON, no markdown code blocks
    - Response MUST include: totalScore, maxScore, breakdown (array), feedback (object), overallComment
    - breakdown array MUST have objects with: category, earned, max, feedback
    - feedback object MUST have: correct (array), missing (array), incorrect (array)
    - If any section is empty, use empty array [] not null
    - Do not add any text before or after the JSON
    - BE STRICT AND FAIR
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