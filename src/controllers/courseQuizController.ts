import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';
import { groqCompletion } from '../lib/groqClient.js';

async function assertEnrolled(userId: string, courseId: string): Promise<boolean> {
  const db = getDB();
  const enr = await db.collection('enrollments').findOne({ student: userId, course: courseId });
  return !!enr;
}

export async function saveCourseQuizAttempt(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;
    const {
      lessonId,
      lessonTitle,
      questions,
      answers,
      score,
      percentage,
      passed,
      secondsPerQuestion,
      transcriptUsed,
    } = req.body;

    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course id' });
    }
    if (!lessonId || typeof lessonId !== 'string') {
      return res.status(400).json({ success: false, message: 'lessonId is required' });
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, message: 'questions array is required' });
    }
    if (typeof score !== 'number' || typeof percentage !== 'number' || typeof passed !== 'boolean') {
      return res.status(400).json({ success: false, message: 'score, percentage, and passed are required' });
    }

    const ok = await assertEnrolled(userId, courseId);
    if (!ok) {
      return res.status(403).json({ success: false, message: 'Not enrolled in this course' });
    }

    const db = getDB();
    const now = new Date();
    const doc = {
      userId,
      courseId,
      lessonId,
      lessonTitle: typeof lessonTitle === 'string' ? lessonTitle : '',
      questions,
      answers: answers && typeof answers === 'object' ? answers : {},
      score,
      percentage,
      passed,
      secondsPerQuestion: typeof secondsPerQuestion === 'number' ? secondsPerQuestion : null,
      transcriptUsed: !!transcriptUsed,
      createdAt: now,
    };

    const result = await db.collection('courseQuizAttempts').insertOne(doc);
    res.status(201).json({ success: true, id: result.insertedId.toString() });
  } catch (e) {
    console.error('saveCourseQuizAttempt', e);
    res.status(500).json({ success: false, message: 'Failed to save quiz attempt' });
  }
}

export async function listCourseQuizAttempts(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;
    const lessonId = typeof req.query.lessonId === 'string' ? req.query.lessonId : '';

    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course id' });
    }

    const ok = await assertEnrolled(userId, courseId);
    if (!ok) {
      return res.status(403).json({ success: false, message: 'Not enrolled in this course' });
    }

    const db = getDB();
    const filter: Record<string, unknown> = { userId, courseId };
    if (lessonId) filter.lessonId = lessonId;

    const limit = lessonId ? 40 : 120;

    const docs = await db
      .collection('courseQuizAttempts')
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    const attempts = docs.map((d: any) => ({
      id: d._id.toString(),
      lessonId: d.lessonId,
      lessonTitle: d.lessonTitle,
      score: d.score,
      total: Array.isArray(d.questions) ? d.questions.length : 0,
      percentage: d.percentage,
      passed: d.passed,
      createdAt: d.createdAt,
    }));

    res.json({ success: true, attempts });
  } catch (e) {
    console.error('listCourseQuizAttempts', e);
    res.status(500).json({ success: false, message: 'Failed to load quiz attempts' });
  }
}

export async function getCourseQuizAttempt(req: AuthRequest, res: Response) {
  try {
    const { courseId, attemptId } = req.params;
    const userId = req.user!.id;

    if (!ObjectId.isValid(courseId) || !ObjectId.isValid(attemptId)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const ok = await assertEnrolled(userId, courseId);
    if (!ok) {
      return res.status(403).json({ success: false, message: 'Not enrolled in this course' });
    }

    const db = getDB();
    const doc = await db.collection('courseQuizAttempts').findOne({
      _id: new ObjectId(attemptId),
      userId,
      courseId,
    });
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Attempt not found' });
    }

    const rawAnswers = (doc as { answers?: Record<string, number> }).answers || {};
    const docAny = doc as unknown as { questions?: unknown[] };
    const qs = Array.isArray(docAny.questions) ? (docAny.questions as any[]) : [];

    const questions = qs.map((q: any, i: number) => {
      const ua = rawAnswers[i] ?? rawAnswers[String(i)];
      const userAnswer = typeof ua === 'number' && !Number.isNaN(ua) ? ua : undefined;
      return {
        question: String(q?.question ?? ''),
        options: Array.isArray(q?.options) ? q.options.map(String) : [],
        correctAnswer: typeof q?.correctAnswer === 'number' ? q.correctAnswer : 0,
        explanation: q?.explanation != null ? String(q.explanation) : '',
        userAnswer,
      };
    });

    res.json({
      success: true,
      attempt: {
        id: (doc as { _id: ObjectId })._id.toString(),
        lessonId: String((doc as { lessonId?: string }).lessonId ?? ''),
        lessonTitle: String((doc as { lessonTitle?: string }).lessonTitle ?? ''),
        score: Number((doc as { score?: number }).score ?? 0),
        total: qs.length,
        percentage: Number((doc as { percentage?: number }).percentage ?? 0),
        passed: Boolean((doc as { passed?: boolean }).passed),
        createdAt: (doc as { createdAt?: Date }).createdAt,
        transcriptUsed: Boolean((doc as { transcriptUsed?: boolean }).transcriptUsed),
        questions,
      },
    });
  } catch (e) {
    console.error('getCourseQuizAttempt', e);
    res.status(500).json({ success: false, message: 'Failed to load attempt' });
  }
}

const QUIZ_PASS_PCT = 65;

/** AI reads this student's saved lesson-quiz attempts for a course and returns Markdown study guidance. */
export async function analyzeQuizHistoryWithAI(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;

    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course id' });
    }

    const enrolled = await assertEnrolled(userId, courseId);
    if (!enrolled) {
      return res.status(403).json({ success: false, message: 'Not enrolled in this course' });
    }

    const db = getDB();
    const courseDoc = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
    const courseTitle = (courseDoc?.title as string) || 'Course';

    const docs = await db
      .collection('courseQuizAttempts')
      .find({ userId, courseId })
      .sort({ createdAt: -1 })
      .limit(120)
      .toArray();

    if (docs.length === 0) {
      return res.json({
        success: true,
        advice:
          'You do not have any saved lesson quizzes in this course yet. Take a **Lesson quiz** from the Learn tab on a few lessons, then open **Quiz scores** again and use **Check with AI** for personalised tips.',
        empty: true,
      });
    }

    const attemptLines: string[] = [];
    for (const d of docs) {
      const any = d as any;
      const total = Array.isArray(any.questions) ? any.questions.length : 0;
      const dateStr = any.createdAt ? new Date(any.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '';
      attemptLines.push(
        `- "${any.lessonTitle || any.lessonId || 'Lesson'}" | ${any.score}/${total} (${any.percentage}%) | pass=${!!any.passed} | ${dateStr}`
      );
    }

    const byLesson = new Map<string, { title: string; pcts: number[]; passedAny: boolean }>();
    for (const d of docs) {
      const any = d as any;
      const lid = String(any.lessonId ?? 'unknown');
      const title = String(any.lessonTitle ?? lid);
      if (!byLesson.has(lid)) byLesson.set(lid, { title, pcts: [], passedAny: false });
      const g = byLesson.get(lid)!;
      g.pcts.push(Number(any.percentage) || 0);
      if (any.passed) g.passedAny = true;
    }
    const aggLines = [...byLesson.entries()].map(([, g]) => {
      const best = Math.max(...g.pcts);
      const worst = Math.min(...g.pcts);
      return `- "${g.title}": n=${g.pcts.length}, best=${best}%, worst=${worst}%, everPassed=${g.passedAny}`;
    });

    let summary = `Course: ${courseTitle}\nPass threshold used in app: ${QUIZ_PASS_PCT}%\n\nPer-lesson rollup:\n${aggLines.join('\n')}\n\nAttempts (newest first):\n${attemptLines.join('\n')}`;
    if (summary.length > 10_000) {
      summary = summary.slice(0, 10_000) + '\n[history truncated for AI size limits]';
    }

    const prompt = `You are a supportive learning coach on an LMS. A student took multiple-choice lesson quizzes in ONE course. Use ONLY the data below — do not invent lessons or scores.

${summary}

Write guidance in **Markdown** with this structure:
1) A short opening (2–4 sentences): overall pattern, strengths, and gaps.
2) ### Topics to prioritise — bullet list; each bullet must reference an actual lesson title from the data.
3) ### How to study — 4–7 concrete tips (e.g. re-watch weak lessons, retry quizzes, spaced repetition, note-taking on misses).
4) ### Next steps — numbered list of 3–5 specific actions for the next study session.

Tone: encouraging and specific. If a lesson never passed, call that out gently. If pass rate is mixed, mention both wins and focus areas.`;

    const completion = await groqCompletion({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.42,
      max_tokens: 2200,
    });

    const advice = completion.choices[0]?.message?.content?.trim() || 'The model returned an empty response. Try again in a moment.';
    res.json({ success: true, advice, empty: false });
  } catch (e: any) {
    console.error('analyzeQuizHistoryWithAI', e);
    const msg = typeof e?.message === 'string' ? e.message : 'AI analysis failed';
    if (/No GROQ_API_KEY|401|API key/i.test(msg)) {
      return res.status(503).json({ success: false, message: 'AI is not configured (GROQ_API_KEY). Add a key on the server to use this feature.' });
    }
    res.status(500).json({ success: false, message: msg });
  }
}
