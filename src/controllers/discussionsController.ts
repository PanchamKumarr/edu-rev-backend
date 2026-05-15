import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';
import { groqCompletion, getGroqKeyStatus } from '../lib/groqClient.js';

async function assertCourseDiscussionAccess(
  db: ReturnType<typeof getDB>,
  userId: string,
  role: string,
  courseId: string
): Promise<boolean> {
  if (role === 'admin') return true;
  if (!ObjectId.isValid(courseId)) return false;
  const course = await db
    .collection('courses')
    .findOne({ _id: new ObjectId(courseId) }, { projection: { instructor: 1 } });
  if (!course) return false;
  if (role === 'instructor' && String((course as any).instructor) === userId) return true;
  const enr = await db.collection('enrollments').findOne({ student: userId, course: courseId });
  return !!enr;
}

function truncate(s: string, max: number) {
  const t = (s || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** POST /:courseId/summary — body optional `{ discussionId }` for a single thread. */
export async function summarizeDiscussions(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const discussionId = typeof req.body?.discussionId === 'string' ? req.body.discussionId.trim() : '';

    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course id' });
    }

    const db = getDB();
    const userId = req.user!.id;
    const role = req.user!.role || 'student';

    const ok = await assertCourseDiscussionAccess(db, userId, role, courseId);
    if (!ok) {
      return res.status(403).json({ success: false, message: 'Not allowed to summarize discussions for this course' });
    }

    if (!getGroqKeyStatus().configured) {
      return res.status(503).json({ success: false, message: 'AI summaries require GROQ_API_KEY on the server' });
    }

    const course = await db.collection('courses').findOne(
      { _id: new ObjectId(courseId) },
      { projection: { title: 1 } }
    );
    const courseTitle = (course as any)?.title || 'Course';

    let prompt: string;
    if (discussionId && ObjectId.isValid(discussionId)) {
      const doc = await db.collection('discussions').findOne({ _id: new ObjectId(discussionId), courseId });
      if (!doc) {
        return res.status(404).json({ success: false, message: 'Discussion not found' });
      }
      const replies = ((doc as any).replies || [])
        .map(
          (r: any) =>
            `- ${r.userName} (${r.userRole}): ${truncate(r.content, 600)}`
        )
        .join('\n');
      prompt = `Summarize this single course discussion thread for busy instructors and classmates.

Course: ${courseTitle}
Thread title: ${truncate((doc as any).title, 200)}
Original post by ${(doc as any).userName}: ${truncate((doc as any).content, 1200)}

Replies:
${replies || '(none)'}

Return ONLY valid JSON:
{
  "headline": "short title",
  "summary": "2-4 sentences",
  "decisionsOrAnswers": ["bullet if any concrete answer/decision"],
  "openQuestions": ["bullet if unresolved"],
  "tone": "one word e.g. collaborative, confused, heated"
}`;
    } else {
      const docs = await db
        .collection('discussions')
        .find({ courseId })
        .sort({ createdAt: -1 })
        .limit(25)
        .toArray();

      if (docs.length === 0) {
        return res.json({
          success: true,
          summary: {
            headline: 'No discussion yet',
            summary: 'There are no topics in this course discussion board yet.',
            themes: [],
            highlights: [],
            openQuestions: [],
            tone: 'n/a',
          },
        });
      }

      const lines = docs.map((d: any, i: number) => {
        const rc = (d.replies || []).length;
        return `${i + 1}. [${d.userName}] ${truncate(d.title, 120)} — ${truncate(d.content, 350)} (${rc} replies)`;
      });

      prompt = `Summarize the discussion board for an online course. Help instructors see themes and student needs.

Course: ${courseTitle}
Threads (${docs.length}):
${lines.join('\n')}

Return ONLY valid JSON:
{
  "headline": "short board overview title",
  "summary": "3-5 sentences overall",
  "themes": ["theme 1", "theme 2"],
  "highlights": ["notable question or insight"],
  "openQuestions": ["unanswered or recurring question"],
  "tone": "one phrase e.g. mostly Q&A, peer support"
}`;
    }

    try {
      const completion = await groqCompletion({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.35,
        max_tokens: 900,
      });
      const text = completion.choices[0]?.message?.content || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      res.json({
        success: true,
        summary: {
          headline: String(parsed.headline || 'Discussion summary'),
          summary: String(parsed.summary || ''),
          themes: Array.isArray(parsed.themes) ? parsed.themes.map(String) : [],
          highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : [],
          openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.map(String) : [],
          tone: String(parsed.tone || ''),
          decisionsOrAnswers: Array.isArray(parsed.decisionsOrAnswers)
            ? parsed.decisionsOrAnswers.map(String)
            : undefined,
        },
      });
    } catch {
      res.json({
        success: true,
        summary: {
          headline: 'Discussion snapshot',
          summary: `Could not run the AI model. There are discussion threads on this board — skim titles for urgent student questions.`,
          themes: [],
          highlights: [],
          openQuestions: [],
          tone: 'n/a',
        },
      });
    }
  } catch (e) {
    console.error('summarizeDiscussions', e);
    res.status(500).json({ success: false, message: 'Failed to summarize discussions' });
  }
}

export async function getDiscussions(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const db = getDB();
    const docs = await db.collection('discussions')
      .find({ courseId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, discussions: docs.map(mapDiscussion) });
  } catch (e) {
    console.error('getDiscussions', e);
    res.status(500).json({ success: false, message: 'Failed to load discussions' });
  }
}

export async function createDiscussion(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const { title, content } = req.body;
    const userId = req.user!.id;

    if (!title?.trim() || !content?.trim()) {
      return res.status(400).json({ success: false, message: 'Title and content are required' });
    }

    const db = getDB();
    const user = ObjectId.isValid(userId)
      ? await db.collection('users').findOne({ _id: new ObjectId(userId) }, { projection: { name: 1, role: 1 } })
      : null;

    const now = new Date();
    const doc = {
      courseId,
      userId,
      userName: user?.name || 'Anonymous',
      userRole: user?.role || 'student',
      title: title.trim(),
      content: content.trim(),
      replies: [],
      likes: 0,
      likedBy: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('discussions').insertOne(doc);
    res.status(201).json({ success: true, discussionId: result.insertedId.toString() });
  } catch (e) {
    console.error('createDiscussion', e);
    res.status(500).json({ success: false, message: 'Failed to create discussion' });
  }
}

export async function addReply(req: AuthRequest, res: Response) {
  try {
    const { discussionId } = req.params;
    const { content } = req.body;
    const userId = req.user!.id;

    if (!content?.trim()) return res.status(400).json({ success: false, message: 'Content is required' });
    if (!ObjectId.isValid(discussionId)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const user = ObjectId.isValid(userId)
      ? await db.collection('users').findOne({ _id: new ObjectId(userId) }, { projection: { name: 1, role: 1 } })
      : null;

    const now = new Date();
    const reply = {
      id: new ObjectId().toString(),
      userId,
      userName: user?.name || 'Anonymous',
      userRole: user?.role || 'student',
      content: content.trim(),
      createdAt: now,
    };

    await db.collection('discussions').updateOne(
      { _id: new ObjectId(discussionId) },
      { $push: { replies: reply } as any, $set: { updatedAt: now } }
    );

    // Notify discussion author
    const discussion = await db.collection('discussions').findOne({ _id: new ObjectId(discussionId) });
    if (discussion && discussion.userId !== userId) {
      await db.collection('notifications').insertOne({
        userId: discussion.userId,
        type: 'reply',
        title: 'New Reply',
        message: `${user?.name || 'Someone'} replied to your discussion: "${discussion.title}"`,
        read: false,
        link: '/dashboard',
        createdAt: now,
      });
    }

    res.json({ success: true, reply });
  } catch (e) {
    console.error('addReply', e);
    res.status(500).json({ success: false, message: 'Failed to add reply' });
  }
}

export async function likeDiscussion(req: AuthRequest, res: Response) {
  try {
    const { discussionId } = req.params;
    const userId = req.user!.id;
    if (!ObjectId.isValid(discussionId)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const doc = await db.collection('discussions').findOne({ _id: new ObjectId(discussionId) });
    if (!doc) return res.status(404).json({ success: false, message: 'Discussion not found' });

    const alreadyLiked = (doc.likedBy || []).includes(userId);
    if (alreadyLiked) {
      await db.collection('discussions').updateOne(
        { _id: new ObjectId(discussionId) },
        { $inc: { likes: -1 }, $pull: { likedBy: userId } as any }
      );
    } else {
      await db.collection('discussions').updateOne(
        { _id: new ObjectId(discussionId) },
        { $inc: { likes: 1 }, $addToSet: { likedBy: userId } as any }
      );
    }

    res.json({ success: true, liked: !alreadyLiked });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to like' });
  }
}

export async function deleteDiscussion(req: AuthRequest, res: Response) {
  try {
    const { discussionId } = req.params;
    const userId = req.user!.id;
    if (!ObjectId.isValid(discussionId)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const doc = await db.collection('discussions').findOne({ _id: new ObjectId(discussionId) });
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (doc.userId !== userId && req.user!.role !== 'admin' && req.user!.role !== 'instructor') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    await db.collection('discussions').deleteOne({ _id: new ObjectId(discussionId) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to delete' });
  }
}

function mapDiscussion(d: any) {
  return {
    id: d._id.toString(),
    courseId: d.courseId,
    userId: d.userId,
    userName: d.userName,
    userRole: d.userRole,
    title: d.title,
    content: d.content,
    replies: d.replies || [],
    likes: d.likes || 0,
    likedBy: d.likedBy || [],
    pinned: d.pinned || false,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
