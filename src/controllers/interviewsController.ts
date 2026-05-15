import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';
import { groqCompletion, getGroqKeyStatus } from '../lib/groqClient.js';

const RESUME_MAX_CHARS = 14_000;
const MAX_USER_TURNS = 22;
const TRANSCRIPT_MAX_CHARS = 10_000;

function truncate(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated]`;
}

function buildInterviewerSystem(topic: string, resumeBlock: string): string {
  const t = topic.trim();
  const r = resumeBlock.trim();
  return `You are a professional interviewer for EDU-REV, an AI learning platform. The learner is practicing interview skills.

${t ? `Interview focus / role or topic: ${t}\n` : 'General interview practice (no specific topic was given).\n'}
${r ? `Candidate résumé (may be partial):\n"""\n${r}\n"""\n` : 'No résumé was provided; do not invent employers, degrees, or dates—only infer from what they say in the interview.\n'}

Rules:
- Conduct a structured interview. Ask ONE clear question at a time (do not ask multiple numbered questions in one message).
- Open with a brief professional greeting (one sentence), then your first question.
- Be concise, fair, and encouraging. Move from motivation/background toward role-relevant or situational questions when a topic was given.
- After each candidate answer, you may give at most one very short acknowledgment (optional), then the next question.
- If they say "end interview", "stop", or "finish", acknowledge and give a brief professional closing (no new heavy question).
- Keep each message under ~220 words.`.trim();
}

const INTERVIEW_JSON_SUFFIX = `

You must reply with ONLY valid JSON (no markdown code fences, no text before or after) in exactly this form:
{"reply":"<your message to the candidate>","closed":boolean}
Rules for "closed":
- Set closed to true when you are ending the mock interview: final goodbye, you will not ask another substantive question, or the candidate asked to stop/finish/end.
- Set closed to false when you are asking another interview question or expecting them to keep answering.
The "reply" field is what the candidate sees (plain text, not JSON).`;

function groqMessagesFromSession(
  systemPrompt: string,
  messages: { role: string; content: string }[],
  options?: { appendJsonSuffix?: boolean }
) {
  const system =
    options?.appendJsonSuffix ? `${systemPrompt}${INTERVIEW_JSON_SUFFIX}` : systemPrompt;
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function parseInterviewerJson(raw: string): { reply: string; closed: boolean } {
  const trimmed = raw.trim();
  try {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    const o = JSON.parse(m[0]) as { reply?: unknown; closed?: unknown };
    const reply = typeof o.reply === 'string' ? o.reply.trim() : trimmed;
    const closed = o.closed === true;
    return { reply: reply || trimmed, closed };
  } catch {
    return { reply: trimmed, closed: false };
  }
}

export async function startInterview(req: AuthRequest, res: Response) {
  try {
    if (!getGroqKeyStatus().configured) {
      return res.status(503).json({ success: false, message: 'Interview mode requires GROQ_API_KEY on the server' });
    }

    let topic = String((req.body as any)?.topic || '').trim();
    let resumeText = String((req.body as any)?.resumeText || '').trim();

    const file = req.file as Express.Multer.File | undefined;
    if (file?.buffer) {
      const name = (file.originalname || '').toLowerCase();
      const isText = /\.(txt|md)$/i.test(name) || file.mimetype === 'text/plain' || file.mimetype === 'text/markdown';
      if (!isText) {
        return res.status(400).json({
          success: false,
          message: 'Resume upload must be a .txt or .md file (or paste resume text below). PDF is not supported yet.',
        });
      }
      const fromFile = file.buffer.toString('utf8').trim();
      resumeText = [resumeText, fromFile].filter(Boolean).join('\n\n').trim();
    }

    resumeText = truncate(resumeText, RESUME_MAX_CHARS);

    if (!topic && !resumeText) {
      return res.status(400).json({
        success: false,
        message: 'Enter an interview topic or role, and/or paste or upload resume text.',
      });
    }

    const userId = req.user!.id;
    const systemPrompt = buildInterviewerSystem(topic || 'General practice', resumeText);

    const completion = await groqCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: '[Session start] You are the interviewer. Greet briefly and ask your first question.',
        },
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.55,
      max_tokens: 700,
    });

    const firstAssistant =
      completion.choices[0]?.message?.content?.trim() ||
      'Hello — thanks for joining today. To start, could you briefly introduce yourself and what kind of role you are preparing for?';

    const now = new Date();
    const doc = {
      userId,
      topic: topic || '(from resume)',
      resumeSnippet: resumeText ? truncate(resumeText, 2000) : '',
      systemPrompt,
      status: 'active' as const,
      messages: [{ role: 'assistant', content: firstAssistant, at: now }],
      userTurnCount: 0,
      rubric: null as Record<string, unknown> | null,
      evaluationSummary: '',
      createdAt: now,
      updatedAt: now,
      completedAt: null as Date | null,
    };

    const db = getDB();
    const result = await db.collection('interviewSessions').insertOne(doc);
    const id = result.insertedId.toString();

    res.status(201).json({
      success: true,
      sessionId: id,
      message: firstAssistant,
    });
  } catch (e: any) {
    console.error('startInterview', e);
    res.status(500).json({ success: false, message: e?.message || 'Failed to start interview' });
  }
}

export async function postInterviewMessage(req: AuthRequest, res: Response) {
  try {
    if (!getGroqKeyStatus().configured) {
      return res.status(503).json({ success: false, message: 'Interview mode requires GROQ_API_KEY on the server' });
    }

    const { id } = req.params;
    const { message } = req.body as { message?: string };
    const text = String(message || '').trim();
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid session id' });
    if (!text) return res.status(400).json({ success: false, message: 'Message is required' });
    if (text.length > 8000) return res.status(400).json({ success: false, message: 'Message too long' });

    const db = getDB();
    const session = await db.collection('interviewSessions').findOne({ _id: new ObjectId(id) });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    if ((session as any).userId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if ((session as any).status !== 'active') {
      return res.status(400).json({
        success: false,
        code: 'INTERVIEW_CLOSED',
        message: 'This interview is already completed.',
        interviewEnded: true,
      });
    }

    if ((session as any).noMoreMessages === true) {
      return res.status(400).json({
        success: false,
        code: 'INTERVIEW_ENDED',
        message: 'This interview has ended. There is nothing more to send.',
        interviewEnded: true,
      });
    }

    const userTurns = Number((session as any).userTurnCount) || 0;
    if (userTurns >= MAX_USER_TURNS) {
      return res.status(400).json({
        success: false,
        code: 'INTERVIEW_MAX_TURNS',
        message: `You have reached the maximum number of replies (${MAX_USER_TURNS}). End the interview to receive your evaluation.`,
      });
    }

    const messages = [...((session as any).messages || [])];
    const now = new Date();
    messages.push({ role: 'user', content: text, at: now });

    const completion = await groqCompletion({
      messages: groqMessagesFromSession(String((session as any).systemPrompt || ''), messages, {
        appendJsonSuffix: true,
      }),
      model: 'llama-3.3-70b-versatile',
      temperature: 0.45,
      max_tokens: 900,
    });

    const raw =
      completion.choices[0]?.message?.content?.trim() ||
      '{"reply":"Thanks for that. Could you tell me more about a challenge you overcame in a team setting?","closed":false}';

    const parsed = parseInterviewerJson(raw);
    let reply = parsed.reply;
    let interviewEnded = parsed.closed;
    const newUserTurns = userTurns + 1;
    if (newUserTurns >= MAX_USER_TURNS) {
      interviewEnded = true;
    }

    messages.push({ role: 'assistant', content: reply, at: new Date() });

    await db.collection('interviewSessions').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          messages,
          userTurnCount: newUserTurns,
          updatedAt: new Date(),
          ...(interviewEnded ? { noMoreMessages: true, endedAt: new Date() } : {}),
        },
      }
    );

    res.json({
      success: true,
      reply,
      userTurns: newUserTurns,
      maxUserTurns: MAX_USER_TURNS,
      interviewEnded,
    });
  } catch (e: any) {
    console.error('postInterviewMessage', e);
    res.status(500).json({ success: false, message: e?.message || 'Failed to continue interview' });
  }
}

function parseEvaluationJson(raw: string): Record<string, unknown> {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return {
      overallScore: null,
      communicationScore: null,
      technicalScore: null,
      strengths: [],
      improvements: [],
      summary: raw.slice(0, 1500),
      recommendation: '',
    };
  }
}

function summarizeRubricForList(r: any) {
  if (!r || typeof r !== 'object') return null;
  return {
    overallScore: r.overallScore ?? null,
    communicationScore: r.communicationScore ?? null,
    technicalScore: r.technicalScore ?? null,
    summary: typeof r.summary === 'string' ? r.summary.slice(0, 280) : '',
  };
}

export async function completeInterview(req: AuthRequest, res: Response) {
  try {
    if (!getGroqKeyStatus().configured) {
      return res.status(503).json({ success: false, message: 'Interview mode requires GROQ_API_KEY on the server' });
    }

    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid session id' });

    const db = getDB();
    const session = await db.collection('interviewSessions').findOne({ _id: new ObjectId(id) });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    if ((session as any).userId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if ((session as any).status === 'completed') {
      return res.json({
        success: true,
        alreadyCompleted: true,
        rubric: (session as any).rubric,
        evaluationSummary: (session as any).evaluationSummary || '',
      });
    }

    const messages = ((session as any).messages || []) as { role: string; content: string }[];
    const lines = messages.map((m, i) => `${m.role.toUpperCase()} ${i + 1}: ${m.content}`);
    const transcript = truncate(lines.join('\n\n'), TRANSCRIPT_MAX_CHARS);

    const evalPrompt = `You reviewed this mock interview transcript. The interviewer was an AI; the candidate is a learner practicing.

Topic: ${(session as any).topic || 'general'}

Transcript:
${transcript}

Return ONLY valid JSON (no markdown fences) with this shape:
{
  "overallScore": <1-10 integer>,
  "communicationScore": <1-10 integer>,
  "technicalScore": <1-10 integer>,
  "strengths": ["...", "..."],
  "improvements": ["...", "..."],
  "summary": "<2-4 sentences>",
  "recommendation": "<one sentence hiring-style takeaway>"
}

Score honestly based on the transcript. If the transcript is very short, note that in summary and use lower confidence scores.`;

    const completion = await groqCompletion({
      messages: [{ role: 'user', content: evalPrompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.25,
      max_tokens: 1200,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '{}';
    const rubric = parseEvaluationJson(raw);
    const summary =
      typeof rubric.summary === 'string'
        ? rubric.summary
        : typeof rubric.recommendation === 'string'
          ? rubric.recommendation
          : 'Evaluation complete.';

    const now = new Date();
    await db.collection('interviewSessions').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: 'completed',
          rubric,
          evaluationSummary: summary,
          completedAt: now,
          updatedAt: now,
          noMoreMessages: true,
        },
      }
    );

    res.json({ success: true, rubric, evaluationSummary: summary });
  } catch (e: any) {
    console.error('completeInterview', e);
    res.status(500).json({ success: false, message: e?.message || 'Failed to complete interview' });
  }
}

export async function listMyInterviews(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    const docs = await db
      .collection('interviewSessions')
      .find({ userId: req.user!.id })
      .sort({ updatedAt: -1 })
      .limit(40)
      .toArray();

    const sessions = docs.map((d: any) => ({
      id: d._id.toString(),
      topic: d.topic,
      status: d.status,
      userTurnCount: d.userTurnCount ?? 0,
      createdAt: d.createdAt,
      completedAt: d.completedAt,
      rubric: d.status === 'completed' ? summarizeRubricForList(d.rubric) : null,
    }));

    res.json({ success: true, sessions });
  } catch (e) {
    console.error('listMyInterviews', e);
    res.status(500).json({ success: false, message: 'Failed to list interviews' });
  }
}

export async function getInterview(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid session id' });

    const db = getDB();
    const d = await db.collection('interviewSessions').findOne({ _id: new ObjectId(id) });
    if (!d) return res.status(404).json({ success: false, message: 'Session not found' });
    if ((d as any).userId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const session = {
      id: (d as any)._id.toString(),
      topic: (d as any).topic,
      resumeSnippet: (d as any).resumeSnippet || '',
      status: (d as any).status,
      noMoreMessages: Boolean((d as any).noMoreMessages),
      messages: ((d as any).messages || []).map((m: any) => ({
        role: m.role,
        content: m.content,
        at: m.at,
      })),
      userTurnCount: (d as any).userTurnCount ?? 0,
      maxUserTurns: MAX_USER_TURNS,
      rubric: (d as any).rubric || null,
      evaluationSummary: (d as any).evaluationSummary || '',
      createdAt: (d as any).createdAt,
      completedAt: (d as any).completedAt,
    };

    res.json({ success: true, session });
  } catch (e) {
    console.error('getInterview', e);
    res.status(500).json({ success: false, message: 'Failed to load session' });
  }
}
