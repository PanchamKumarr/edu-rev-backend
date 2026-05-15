import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';
import { groqCompletion, getGroqKeyStatus } from '../lib/groqClient.js';

async function assertCourseReviewAccess(
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

function trunc(s: string, max: number) {
  const t = (s || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** One review per learner per course; keep newest if legacy duplicates exist. */
export function dedupeReviewsByUser(reviews: any[]): any[] {
  const byUser = new Map<string, any>();
  for (const r of reviews) {
    const k = String(r.userId ?? '');
    if (!byUser.has(k)) byUser.set(k, r);
  }
  return Array.from(byUser.values());
}

export async function addReview(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const { rating, comment } = req.body;
    const userId = req.user!.id;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be 1-5' });
    }

    const db = getDB();

    // Must be enrolled
    const enrollment = await db.collection('enrollments').findOne({ student: userId, course: courseId });
    if (!enrollment) return res.status(403).json({ success: false, message: 'You must be enrolled to review' });

    // Get user name
    const user = ObjectId.isValid(userId)
      ? await db.collection('users').findOne({ _id: new ObjectId(userId) }, { projection: { name: 1 } })
      : null;

    const now = new Date();

    // Upsert review (one per user per course)
    await db.collection('reviews').updateOne(
      { userId, courseId },
      { $set: { rating: Number(rating), comment: comment?.trim() || '', userName: user?.name || 'Anonymous', updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );

    // Remove legacy duplicate rows for same user + course (different _id)
    const sameUser = await db.collection('reviews').find({ courseId, userId }).sort({ updatedAt: -1, createdAt: -1 }).toArray();
    if (sameUser.length > 1) {
      const [, ...dupes] = sameUser;
      await db.collection('reviews').deleteMany({ _id: { $in: dupes.map((d) => d._id) } });
    }

    // Recalculate average from unique learners only
    const allRaw = await db.collection('reviews').find({ courseId }).sort({ updatedAt: -1 }).toArray();
    const allReviews = dedupeReviewsByUser(allRaw);
    const avgRating =
      allReviews.length > 0 ? allReviews.reduce((sum: number, r: any) => sum + r.rating, 0) / allReviews.length : 0;

    if (ObjectId.isValid(courseId)) {
      await db.collection('courses').updateOne(
        { _id: new ObjectId(courseId) },
        { $set: { rating: Math.round(avgRating * 10) / 10, reviewCount: allReviews.length } }
      );
    }

    res.json({ success: true, message: 'Review submitted', avgRating: Math.round(avgRating * 10) / 10 });
  } catch (e) {
    console.error('addReview', e);
    res.status(500).json({ success: false, message: 'Failed to submit review' });
  }
}

/** POST /:courseId/summary — AI digest of all learner ratings & comments (enrolled / instructor / admin). */
export async function summarizeCourseReviews(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course id' });
    }

    const db = getDB();
    const userId = req.user!.id;
    const role = req.user!.role || 'student';

    const ok = await assertCourseReviewAccess(db, userId, role, courseId);
    if (!ok) {
      return res.status(403).json({ success: false, message: 'Not allowed to summarize reviews for this course' });
    }

    if (!getGroqKeyStatus().configured) {
      return res.status(503).json({ success: false, message: 'AI summaries require GROQ_API_KEY on the server' });
    }

    const course = await db.collection('courses').findOne(
      { _id: new ObjectId(courseId) },
      { projection: { title: 1, rating: 1, reviewCount: 1 } }
    );
    const title = (course as any)?.title || 'Course';
    const avg = typeof (course as any)?.rating === 'number' ? (course as any).rating : null;

    const raw = await db.collection('reviews').find({ courseId }).sort({ updatedAt: -1 }).toArray();
    const reviews = dedupeReviewsByUser(raw);

    if (reviews.length === 0) {
      return res.json({
        success: true,
        summary: {
          headline: 'No ratings yet',
          summary: 'There are no learner reviews for this course yet.',
          ratingOverview: avg != null ? `Listed course average: ${avg}/5` : '',
          strengths: [],
          watchouts: [],
          themes: [],
        },
      });
    }

    const lines = reviews.map((r: any, i: number) => {
      return `${i + 1}. ${r.rating}/5 — ${r.userName}: ${trunc(r.comment || '(no comment)', 400)}`;
    });

    const prompt = `You summarize learner ratings for an online course. Be fair and anonymize individuals (use "learners" not real names in the summary text). Course: "${title}".
Official average on record: ${avg != null ? `${avg}/5` : 'n/a'} from ${reviews.length} learner(s).

Reviews:
${lines.join('\n')}

Return ONLY valid JSON:
{
  "headline": "short title",
  "summary": "3-5 sentences for the instructor",
  "ratingOverview": "one sentence about the star pattern",
  "strengths": ["what learners appreciate"],
  "watchouts": ["recurring criticism or risk, if any"],
  "themes": ["optional recurring themes from comments"]
}`;

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
          headline: String(parsed.headline || 'Ratings summary'),
          summary: String(parsed.summary || ''),
          ratingOverview: String(parsed.ratingOverview || ''),
          strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
          watchouts: Array.isArray(parsed.watchouts) ? parsed.watchouts.map(String) : [],
          themes: Array.isArray(parsed.themes) ? parsed.themes.map(String) : [],
        },
      });
    } catch {
      res.json({
        success: true,
        summary: {
          headline: 'Ratings snapshot',
          summary: `There are ${reviews.length} learner review(s). Average rating on file: ${avg != null ? `${avg}/5` : 'see course card'}.`,
          ratingOverview: '',
          strengths: [],
          watchouts: [],
          themes: [],
        },
      });
    }
  } catch (e) {
    console.error('summarizeCourseReviews', e);
    res.status(500).json({ success: false, message: 'Failed to summarize reviews' });
  }
}

export async function getCourseReviews(req: any, res: Response) {
  try {
    const { courseId } = req.params;
    const db = getDB();

    const raw = await db.collection('reviews')
      .find({ courseId })
      .sort({ updatedAt: -1 })
      .toArray();

    const reviews = dedupeReviewsByUser(raw);

    const mapped = reviews.map((r: any) => ({
      id: r._id.toString(),
      userId: r.userId,
      userName: r.userName,
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    const avg = mapped.length > 0 ? mapped.reduce((s, r) => s + r.rating, 0) / mapped.length : 0;
    res.json({ success: true, reviews: mapped, avgRating: Math.round(avg * 10) / 10, count: mapped.length });
  } catch (e) {
    console.error('getCourseReviews', e);
    res.status(500).json({ success: false, message: 'Failed to load reviews' });
  }
}

export async function deleteReview(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;
    const db = getDB();
    await db.collection('reviews').deleteOne({ userId, courseId });

    const raw = await db.collection('reviews').find({ courseId }).sort({ updatedAt: -1 }).toArray();
    const all = dedupeReviewsByUser(raw);
    const avgRating = all.length > 0 ? all.reduce((s: number, r: any) => s + r.rating, 0) / all.length : 0;
    if (ObjectId.isValid(courseId)) {
      await db.collection('courses').updateOne(
        { _id: new ObjectId(courseId) },
        { $set: { rating: Math.round(avgRating * 10) / 10, reviewCount: all.length } }
      );
    }

    res.json({ success: true, message: 'Review deleted' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to delete review' });
  }
}
