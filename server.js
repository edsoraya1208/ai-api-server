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
        model: 'meta-llama/llama-4-scout',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this ERD diagram. Return ONLY valid JSON.

SCOPE - WE DETECT:
✅ Strong/Weak Entities
✅ Relationships (1:1, 1:N, M:N)
✅ Attributes belonging to: Entities, Relationships, or other Attributes (composite)
✅ Primary Key, Foreign Key, Regular, Derived, Multivalued, Composite attributes

❌ OUT OF SCOPE (mark as "other" if found):
- ISA/Inheritance relationships
- Aggregation
- Ternary relationships (3+ entities)
- Participation constraints

IF NOT AN ERD: {"isERD": false, "reason": "describe what it is"}

IF IS AN ERD: 
{
  "isERD": true,
  "elements": [
    {"id": "el_1", "name": "Student", "type": "entity", "subType": "strong", "confidence": 95},
    {"id": "el_2", "name": "enrolls", "type": "relationship", "subType": "many-to-many", "from": "Student", "to": "Course", "confidence": 88},
    {"id": "el_3", "name": "StudentID", "type": "attribute", "subType": "primary_key", "belongsTo": "Student", "belongsToType": "entity", "confidence": 92},
    {"id": "el_4", "name": "enrollment_date", "type": "attribute", "subType": "regular", "belongsTo": "enrolls", "belongsToType": "relationship", "confidence": 85},
    {"id": "el_5", "name": "Street", "type": "attribute", "subType": "composite", "belongsTo": "Address", "belongsToType": "attribute", "confidence": 90}
  ]
}

CRITICAL RULES:
- Each element MUST have unique "id" (e.g., "el_1", "el_2", etc.)
- Entity subTypes: "strong", "weak"
- Relationship subTypes: "one-to-one", "one-to-many", "many-to-many"
- Attribute subTypes: "primary_key", "foreign_key", "regular", "derived", "multivalued", "composite"
- Relationships MUST have "from" and "to" (entity names)
- Attributes MUST have "belongsTo" (name) and "belongsToType" ("entity", "relationship", or "attribute")
- confidence: 0-100 (your certainty level)
- If you find ISA/inheritance, mark as type: "other", subType: "isa_relationship"
- Return ONLY JSON, no markdown, no extra text`
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

// 🆕 NEW ENDPOINT: Analyze rubric for grading criteria
app.post('/detect-rubric', async (req, res) => {
  try {
    const { rubricUrl } = req.body;

    if (!rubricUrl) {
      return res.status(400).json({ error: 'Missing rubricUrl' });
    }

    console.log('🔍 Analyzing rubric:', rubricUrl);

    // Download PDF/image (60 second timeout)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const rubricResponse = await fetch(rubricUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!rubricResponse.ok) {
      throw new Error('Failed to fetch rubric file');
    }

    const rubricBuffer = await rubricResponse.arrayBuffer();
    const base64Rubric = Buffer.from(rubricBuffer).toString('base64');

    // Determine file type from URL
    const fileExtension = rubricUrl.toLowerCase().split('.').pop();
    const mimeType = fileExtension === 'pdf' ? 'application/pdf' : 'image/png';

    // Call OpenRouter AI with rubric analysis prompt
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
          content: [
            {
              type: 'text',
              text: `Analyze this grading rubric. Return ONLY valid JSON.

SCOPE - WE EXTRACT:
✅ Rubrics for ERD diagram grading
✅ Grading categories (Entities, Relationships, Attributes, Keys, Notation, etc.)
✅ Point allocations per category
✅ Grading criteria/descriptions
✅ Total marks

❌ OUT OF SCOPE (reject if found):
- Rubrics for SQL queries, normalization, or non-ERD topics
- Completely unreadable/corrupted files
- Non-grading documents

IF NOT AN ERD RUBRIC:
{
  "isERDRubric": false,
  "reason": "This rubric is for SQL queries, not ERD diagrams"
}

IF IS AN ERD RUBRIC:
{
  "isERDRubric": true,
  "totalPoints": 100,
  "criteria": [
    {
      "category": "Entities",
      "maxPoints": 30,
      "description": "All entities correctly identified with proper notation (rectangles). Strong/weak entities distinguished."
    },
    {
      "category": "Relationships",
      "maxPoints": 30,
      "description": "Cardinality correct (1:1, 1:N, M:N). Relationship names meaningful."
    },
    {
      "category": "Attributes",
      "maxPoints": 25,
      "description": "All attributes mapped correctly. Primary keys underlined. Composite/multivalued shown properly."
    }
  ],
  "notes": "Rubric emphasizes correct notation and completeness"
}

CRITICAL RULES:
- Each criterion MUST have: "category" (string), "maxPoints" (number), "description" (string)
- totalPoints should sum up all maxPoints (if not explicitly stated, infer from criteria)
- If points not clearly stated, estimate based on emphasis (e.g., if rubric says "Entities are important" → assume higher points)
- Extract ALL grading aspects mentioned (even if vague)
- If rubric is vague/unstructured, do your best to extract meaningful criteria
- Return ONLY JSON, no markdown, no extra text`
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Rubric}` }
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

    console.log('✅ Rubric analysis complete');
    return res.status(200).json(result);

  } catch (error) {
    console.error('❌ Error:', error);
    
    if (error.name === 'AbortError') {
      return res.status(408).json({ 
        error: 'Request timeout',
        message: 'Rubric analysis took too long',
        isERDRubric: false
      });
    }
    
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