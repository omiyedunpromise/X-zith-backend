// ============================================================
// TEXTBOOK GENERATOR
// ============================================================
app.post('/api/generate-textbook', async (req, res) => {
  try {
    const { level, subject, topic } = req.body;
    if (!level || !subject || !topic) {
      return res.status(400).json({ error: 'level, subject, and topic are required' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const prompt = `You are an expert Nigerian secondary school teacher.
Write comprehensive study notes for a ${level} student on the topic "${topic}" in ${subject}.
Format with markdown headings (##), bullet points, and examples.
Keep it clear and exam-focused (WAEC/NECO/JAMB style).`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: 60000 }
    );

    const note = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!note) return res.status(500).json({ error: 'No content generated' });

    res.json({ success: true, note });
  } catch (err) {
    console.error('Textbook error:', err.message);
    res.status(500).json({ error: 'Failed to generate textbook: ' + err.message });
  }
});

// ============================================================
// PAST QUESTIONS GENERATOR
// ============================================================
app.post('/api/generate-past-questions', async (req, res) => {
  try {
    const { exam, year, subject, qtype, count, topic } = req.body;
    if (!exam || !year || !subject) {
      return res.status(400).json({ error: 'exam, year, and subject are required' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const n = Math.min(parseInt(count) || 10, 20);
    const topicLine = topic ? `Focus on the topic: "${topic}".` : '';

    const prompt = `You are an examiner for ${exam} (${year}) in Nigeria.
Generate ${n} ${qtype || 'Objective'} questions for ${subject}. ${topicLine}

For each question use this exact format:

1. Question text here?
A) option one
B) option two
C) option three
D) option four
Answer: B
Explanation: Short reason.

Repeat for all ${n} questions. Only output the questions.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: 90000 }
    );

    const raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!raw) return res.status(500).json({ error: 'No questions generated' });

    res.json({ success: true, raw });
  } catch (err) {
    console.error('Past questions error:', err.message);
    res.status(500).json({ error: 'Failed to generate questions: ' + err.message });
  }
});

// ============================================================
// THEORY QUESTION
// ============================================================
app.post('/api/generate-theory-question', async (req, res) => {
  try {
    const { exam, subject } = req.body;
    if (!exam || !subject) {
      return res.status(400).json({ error: 'exam and subject are required' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const prompt = `You are a ${exam} examiner in Nigeria.
Generate ONE theory/essay question for ${subject}.
Include the question and any sub-parts (a), (b), (c) with mark allocations.
Do not include the answer. Only the question.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: 60000 }
    );

    const question = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!question) return res.status(500).json({ error: 'No question generated' });

    res.json({ success: true, question });
  } catch (err) {
    console.error('Theory question error:', err.message);
    res.status(500).json({ error: 'Failed to generate theory question: ' + err.message });
  }
});

// ============================================================
// THEORY EXPLANATION
// ============================================================
app.post('/api/explain-theory-question', async (req, res) => {
  try {
    const { exam, subject, question } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const prompt = `You are a Nigerian secondary school teacher.
Provide a clear, detailed model answer and explanation for this ${exam} ${subject} theory question:

${question}

Break down each part, show working where needed, and give exam tips.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: 60000 }
    );

    const explanation = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!explanation) return res.status(500).json({ error: 'No explanation generated' });

    res.json({ success: true, explanation });
  } catch (err) {
    console.error('Theory explanation error:', err.message);
    res.status(500).json({ error: 'Failed to generate explanation: ' + err.message });
  }
});