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

// 🆕 Auto-grading endpoint (Hybrid: Code does Math, AI does Feedback)
app.post('/autograde-erd', async (req, res) => {
  try {
    const { studentElements, correctAnswer, rubricStructured } = req.body;

    // 1. VALIDATION
    if (!studentElements || !correctAnswer || !correctAnswer.elements) {
      return res.status(400).json({ error: 'Missing required data' });
    }

    // 2. GROUND TRUTH (The Denominators)
    // We calculate exactly how many items exist in the correct answer.
    const groundTruth = {
      entities: correctAnswer.elements.filter(e => e.type === 'entity').length,
      attributes: correctAnswer.elements.filter(e => e.type === 'attribute').length,
      relationships: correctAnswer.elements.filter(e => e.type === 'relationship').length,
      // Cardinality is always double the number of relationships (From + To)
      cardinalities: correctAnswer.elements.filter(e => e.type === 'relationship').length * 2
    };

    console.log('📊 Ground Truth:', groundTruth);

    // 3. AI PROMPT - The "Teacher & Counter"
    // We ask for COUNTS (for the code) and FEEDBACK (for the student)
    const prompt = `You are a STRICT ERD Grading Assistant. 

**CORRECT DATA:**
${JSON.stringify(correctAnswer.elements)}

**STUDENT DATA:**
${JSON.stringify(studentElements)}

**TASK:**
Compare Student vs Correct data. 
1. **Count Matches** for the "Counts" object (Logic: Semantic match is okay, e.g., "Client"=="Customer").
2. **Write Feedback** for the "Feedback" object.

**COUNTING RULES (for the 'counts' object):**
- Entities: Count correct entity names.
- Attributes: Count correct attributes (must belong to correct Entity).
- Relationships: Count correct relationships (must connect correct Entities).
- Cardinality: Count EXACT matches of ends. "0..M" is NOT "1..M". (Max count = ${groundTruth.cardinalities}).

**FEEDBACK TONE (CRITICAL):**
- **Direct Address:** Use "You correctly identified..." or "You missed...". NOT "The student...".
- **No Fluff:** Do not write "Let me check" or "Calculating score".
- **Helpful & Strict:** Explain *why* something is wrong (e.g., "Advises should be 1..N because one professor advises many students").
- **Leniency:** If you accept a synonym (e.g. Phone vs PhoneNumber), count it as correct but mention it in feedback.
- **Overall:** If perfect, say "Excellent work! All elements are correct."

**OUTPUT FORMAT (JSON ONLY):**
{
  "counts": {
    "entities_correct": Number,
    "attributes_correct": Number,
    "relationships_correct": Number,
    "cardinality_correct": Number
  },
  "feedback": {
    "correct": ["List specific correct items..."],
    "missing": ["List missing items..."],
    "incorrect": ["List errors with specific advice..."]
  },
  "overallComment": "One or two sentences summarizing the student's performance."
}`;

    // 4. CALL AI
    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite-preview-09-2025', 
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1, // Keep low for consistent counting
        response_format: { type: "json_object" }
      })
    });

    if (!aiResponse.ok) throw new Error(`OpenRouter failed: ${aiResponse.statusText}`);
    const aiData = await aiResponse.json();
    
    // Clean Response
    const cleanContent = aiData.choices[0].message.content.replace(/```json|```/g, '').trim();
    const aiResult = JSON.parse(cleanContent);

    // 5. THE ACCOUNTANT (Calculate Scores in Node.js)
    let totalScore = 0;
    let maxTotalScore = 0;
    const breakdown = [];

    // Helper to apply rubric weights to AI counts
    const calculateCategory = (keyword, aiCount, totalPossible) => {
        // Find rubric criteria matching the keyword (e.g., "Entity")
        const criterion = rubricStructured?.criteria.find(c => c.category.toLowerCase().includes(keyword)) 
                       || { maxPoints: 0, category: keyword }; // Fallback

        const maxPoints = criterion.maxPoints || 0;
        
        // Math: (Matches / TotalPossible) * MaxPoints
        const ratio = totalPossible > 0 ? (aiCount / totalPossible) : 0;
        const earned = ratio * maxPoints;

        if (maxPoints > 0) {
            totalScore += earned;
            maxTotalScore += maxPoints;
            breakdown.push({
                category: criterion.category,
                earned: parseFloat(earned.toFixed(2)),
                max: maxPoints,
                // We use a simple status here, relying on the main feedback object for details
                feedback: `Matched ${aiCount} of ${totalPossible} expected elements.`
            });
        }
    };

    // Calculate each section
    calculateCategory('entit', aiResult.counts.entities_correct, groundTruth.entities);
    calculateCategory('attribut', aiResult.counts.attributes_correct, groundTruth.attributes);
    calculateCategory('relation', aiResult.counts.relationships_correct, groundTruth.relationships);
    // Some rubrics combine cardinality with relationships. If separate:
    if (rubricStructured?.criteria.some(c => c.category.toLowerCase().includes('cardinal'))) {
        calculateCategory('cardinal', aiResult.counts.cardinality_correct, groundTruth.cardinalities);
    }

    // 6. FINAL RESULT
    const finalResult = {
        totalScore: parseFloat(totalScore.toFixed(2)),
        maxScore: maxTotalScore || 100, 
        breakdown: breakdown,
        // We use the AI's high-quality text feedback here
        feedback: aiResult.feedback, 
        overallComment: aiResult.overallComment
    };

    console.log(`✅ Graded: ${finalResult.totalScore}/${finalResult.maxScore}`);
    return res.status(200).json(finalResult);

  } catch (error) {
    console.error('❌ Auto-grading error:', error);
    return res.status(500).json({ error: 'Auto-grading failed', message: error.message });
  }
});