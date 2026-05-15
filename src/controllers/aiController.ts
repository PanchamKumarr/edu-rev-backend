import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { AuthRequest } from '../middleware/auth.js';
import { groqCompletion, getGroqKeyStatus } from '../lib/groqClient.js';
import { getDB } from '../db/connection.js';
import { fetchYoutubeTranscriptPlain } from '../lib/youtubeTranscript.js';

/** Max characters of source material (transcript + notes) sent to the model; avoids 413 / TPM errors on free tier. */
function mcqSourceCharCap(): number {
  const raw = Number.parseInt(process.env.GROQ_MCQ_MAX_SOURCE_CHARS ?? '', 10);
  if (Number.isFinite(raw) && raw >= 2000 && raw <= 14_000) return raw;
  return 7_000;
}

export async function generateMCQ(req: AuthRequest, res: Response) {
  const { topic, content, numQuestions = 5, difficulty = 'medium', videoUrl: rawVideoUrl } = req.body;

  const contentStr = typeof content === 'string' ? content.trim() : '';
  const topicStr = typeof topic === 'string' ? topic.trim() : '';
  const videoUrl = typeof rawVideoUrl === 'string' ? rawVideoUrl.trim() : '';

  let transcriptUsed = false;
  let transcriptTruncated = false;
  let combinedContent = contentStr;

  if (videoUrl) {
    const tr = await fetchYoutubeTranscriptPlain(videoUrl);
    if (tr.ok) {
      combinedContent = [
        '=== VIDEO TRANSCRIPT (primary source) ===',
        tr.text,
        contentStr ? `\n=== ADDITIONAL LESSON NOTES ===\n${contentStr}` : '',
      ].join('\n');
      transcriptUsed = true;
      transcriptTruncated = tr.truncated;
    } else if (tr.reason === 'unavailable') {
      if (!contentStr && !topicStr) {
        return res.status(400).json({
          success: false,
          message: `Could not load YouTube transcript: ${tr.message}. Add lesson notes, or use a video that has captions/transcript enabled.`,
        });
      }
    }
  }

  if (!topicStr && !combinedContent) {
    return res.status(400).json({
      success: false,
      message: 'Provide a topic, pasted lesson text, or a YouTube lesson URL with captions so we can build the quiz.',
    });
  }

  const cap = mcqSourceCharCap();
  if (combinedContent.length > cap) {
    combinedContent =
      combinedContent.slice(0, cap) +
      '\n\n[...source material truncated to stay within API size limits; questions should still follow the visible text above.]';
    transcriptTruncated = true;
  }

  const anchorTopic = topicStr || (transcriptUsed ? 'the video lesson' : 'the provided content');

  const prompt = `Generate exactly ${numQuestions} multiple choice questions about: "${anchorTopic}"
${transcriptUsed ? '\nPrioritize the VIDEO TRANSCRIPT section: each question should be clearly answerable from what is said in the transcript. Use ADDITIONAL LESSON NOTES only as supporting context when present.\n' : ''}
${combinedContent ? `\nBased on this material:\n${combinedContent}\n` : ''}

Difficulty level: ${difficulty}

Return ONLY a valid JSON object with a "questions" array using this exact structure:
{
  "questions": [
    {
      "question": "Question text here?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": 0,
      "explanation": "Brief explanation of why this answer is correct"
    }
  ]
}

Rules:
- correctAnswer is the 0-based index of the correct option (0, 1, 2, or 3)
- Each question must have exactly 4 options
- Questions should be clear and test understanding
- Do not include any text outside the JSON`;

  try {
    const completion = await groqCompletion({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.6,
      max_tokens: 3000,
    });

    const text = completion.choices[0]?.message?.content || '{}';
    let questions: any[] = [];

    try {
      const parsed = JSON.parse(text);
      questions = Array.isArray(parsed) ? parsed : (parsed.questions || parsed.mcqs || []);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          questions = parsed.questions || parsed.mcqs || [];
        } catch {
          return res.status(500).json({ success: false, message: 'Failed to parse AI response' });
        }
      } else {
        return res.status(500).json({ success: false, message: 'Failed to parse AI response' });
      }
    }

    res.json({
      success: true,
      questions,
      count: questions.length,
      transcriptUsed,
      transcriptTruncated,
    });
  } catch (e: any) {
    console.error('generateMCQ error:', e);
    res.status(500).json({ success: false, message: e.message || 'AI service error' });
  }
}

function parseCareerRoadmapJson(text: string): Record<string, unknown> {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return {
      title: 'Career roadmap',
      summary: text.slice(0, 2000),
      estimatedTimeline: '',
      phases: [],
      recommendedResources: [],
      nextStepsThisWeek: [],
      parseError: true,
    };
  }
}

/** Student describes a career goal; AI returns a structured learning/career roadmap. */
export async function generateCareerRoadmap(req: AuthRequest, res: Response) {
  if (!getGroqKeyStatus().configured) {
    return res.status(503).json({
      success: false,
      message: 'Career roadmap requires GROQ_API_KEY on the server',
    });
  }

  const goal = typeof (req.body as any)?.goal === 'string' ? (req.body as any).goal.trim() : '';
  if (goal.length < 20) {
    return res.status(400).json({
      success: false,
      message: 'Describe your career goal in at least 20 characters (role, industry, skills you want, or timeline).',
    });
  }
  if (goal.length > 4000) {
    return res.status(400).json({ success: false, message: 'Please keep your description under 4000 characters.' });
  }

  const prompt = `You are a career and learning advisor for students using an online learning platform.

The student wrote what they want for their career (goals, role, industry, constraints, or questions):
"""
${goal}
"""

Return ONLY valid JSON (no markdown code fences) with this exact shape:
{
  "title": "<short motivating title for their roadmap>",
  "summary": "<2-5 sentences: reflect their goal, assumptions, and how the roadmap helps>",
  "estimatedTimeline": "<realistic range, e.g. 6-12 months at ~10h/week — adjust to their text>",
  "phases": [
    {
      "name": "<phase name>",
      "durationHint": "<e.g. 4-8 weeks>",
      "focus": "<1-2 sentences on what this phase achieves>",
      "skills": ["<skill or topic>", "..."],
      "milestones": ["<checkable milestone>", "..."],
      "learningActions": ["<concrete action: course topic, project, practice>", "..."]
    }
  ],
  "recommendedResources": ["<types: courses, certs, communities, portfolios — short bullets>", "..."],
  "nextStepsThisWeek": ["<one very concrete step>", "<second step>", "..."]
}

Rules:
- Use 4-6 phases for a clear roadmap; order from foundations to job-ready/portfolio.
- Be practical and honest: note if their goal is vague and suggest how to clarify in summary.
- skills, milestones, learningActions: max 6 items each per phase; keep strings concise.
- recommendedResources and nextStepsThisWeek: max 8 items each.
- Tailor actions to skills that transfer across employers (projects, GitHub, portfolio, mock interviews) when relevant.`;

  try {
    const completion = await groqCompletion({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.35,
      max_tokens: 3500,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    const roadmap = parseCareerRoadmapJson(raw);

    res.json({
      success: true,
      roadmap,
    });
  } catch (e: any) {
    console.error('generateCareerRoadmap', e);
    res.status(500).json({ success: false, message: e?.message || 'Could not generate roadmap' });
  }
}

export async function chatWithAI(req: AuthRequest, res: Response) {
  const { message, history = [], context } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ success: false, message: 'Message is required' });
  }

  const systemPrompt = `You are an expert AI learning assistant for the EDU-REV platform — an AI-powered adaptive learning management system. Your role is to:
- Help students understand course content and concepts clearly
- Answer academic questions with depth and accuracy
- Suggest learning strategies and study tips
- Break down complex topics into easy-to-understand explanations
- Provide examples and analogies to aid comprehension
- Guide learners through problem-solving step by step
${context ? `\nCurrent course context: ${context}` : ''}

Be encouraging, patient, and pedagogically effective. Keep responses concise but complete.`;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10).map((h: any) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    const completion = await groqCompletion({
      messages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 1024,
    });

    const reply = completion.choices[0]?.message?.content || '';
    res.json({ success: true, reply });
  } catch (e: any) {
    console.error('chatWithAI error:', e);
    res.status(500).json({ success: false, message: e.message || 'AI service error' });
  }
}

export async function saveMCQAttempt(req: AuthRequest, res: Response) {
  try {
    const { topic, difficulty, questions, answers, score, percentage, analysis, session, perQuestion, analysisDetailed } = req.body;
    if (!Array.isArray(questions) || typeof score !== 'number') {
      return res.status(400).json({ success: false, message: 'questions and score are required' });
    }

    const db = getDB();
    const now = new Date();
    const doc = {
      userId: req.user!.id,
      topic: topic || 'AI Generated Quiz',
      difficulty: difficulty || 'medium',
      questions,
      answers: answers || {},
      score,
      percentage: typeof percentage === 'number' ? percentage : Math.round((score / questions.length) * 100),
      analysis: analysis || '',
      analysisDetailed: typeof analysisDetailed === 'string' ? analysisDetailed : '',
      session: session && typeof session === 'object' ? session : undefined,
      perQuestion: Array.isArray(perQuestion) ? perQuestion : undefined,
      createdAt: now,
    };

    const result = await db.collection('aiQuizAttempts').insertOne(doc);
    await db.collection('activity').insertOne({
      userId: req.user!.id,
      type: 'ai_quiz_attempt',
      topic: doc.topic,
      score: doc.score,
      percentage: doc.percentage,
      timestamp: now,
    });

    res.status(201).json({ success: true, attemptId: result.insertedId.toString() });
  } catch (e) {
    console.error('saveMCQAttempt', e);
    res.status(500).json({ success: false, message: 'Failed to save attempt' });
  }
}

export async function listMCQAttempts(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    const docs = await db.collection('aiQuizAttempts')
      .find({ userId: req.user!.id })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    const attempts = docs.map((d: any) => ({
      id: d._id.toString(),
      topic: d.topic,
      difficulty: d.difficulty,
      score: d.score,
      percentage: d.percentage,
      analysis: d.analysis,
      analysisDetailed: d.analysisDetailed,
      session: d.session,
      totalQuestions: Array.isArray(d.questions) ? d.questions.length : 0,
      createdAt: d.createdAt,
    }));

    res.json({ success: true, attempts });
  } catch (e) {
    console.error('listMCQAttempts', e);
    res.status(500).json({ success: false, message: 'Failed to load attempts' });
  }
}

export async function getMCQAttempt(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!id || !ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid attempt id' });
    }
    const db = getDB();
    const doc = await db.collection('aiQuizAttempts').findOne({
      _id: new ObjectId(id),
      userId: req.user!.id,
    });
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Attempt not found' });
    }
    res.json({
      success: true,
      attempt: {
        id: doc._id.toString(),
        topic: doc.topic,
        difficulty: doc.difficulty,
        score: doc.score,
        percentage: doc.percentage,
        analysis: doc.analysis,
        analysisDetailed: doc.analysisDetailed,
        session: doc.session,
        perQuestion: doc.perQuestion,
        questions: doc.questions,
        answers: doc.answers,
        totalQuestions: Array.isArray(doc.questions) ? doc.questions.length : 0,
        createdAt: doc.createdAt,
      },
    });
  } catch (e) {
    console.error('getMCQAttempt', e);
    res.status(500).json({ success: false, message: 'Failed to load attempt' });
  }
}
