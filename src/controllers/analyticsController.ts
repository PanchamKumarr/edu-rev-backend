import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';
import { groqCompletion } from '../lib/groqClient.js';
import type { IInsightsProfile } from '../models/index.js';

/** Shared payload for GET /analytics/me and AI summary. */
export async function buildStudentAnalyticsPayload(userId: string) {
  const db = getDB();
  const oid = ObjectId.isValid(userId) ? new ObjectId(userId) : null;

  const [
    enrollments,
    submissions,
    mastery,
    activities,
    certificates,
    aiAttempts,
    courseQuizAttempts,
    userDoc,
    discussionThreads,
    interviewsCompleted,
  ] = await Promise.all([
    db.collection('enrollments').find({ student: userId }).toArray(),
    db.collection('submissions').find({ studentId: userId }).toArray(),
    db.collection('mastery').find({ userId }).toArray(),
    db.collection('activity').find({ userId }).sort({ timestamp: -1 }).limit(50).toArray(),
    db.collection('certificates').find({ userId }).toArray(),
    db.collection('aiQuizAttempts').find({ userId }).sort({ createdAt: -1 }).limit(20).toArray(),
    db.collection('courseQuizAttempts').find({ userId }).sort({ createdAt: -1 }).limit(40).toArray(),
    oid ? db.collection('users').findOne({ _id: oid }, { projection: { insightsProfile: 1 } }) : Promise.resolve(null),
    db.collection('discussions').countDocuments({ userId }),
    db.collection('interviewSessions').countDocuments({ userId, status: 'completed' }),
  ]);

  const insightsProfile = (userDoc?.insightsProfile || null) as IInsightsProfile | null;

  const courseIds = [...new Set(enrollments.map((e: any) => e.course).filter(Boolean))];
  const validCourseOids = courseIds.filter((id: string) => ObjectId.isValid(id)).map((id: string) => new ObjectId(id));
  const courses =
    validCourseOids.length > 0
      ? await db.collection('courses').find({ _id: { $in: validCourseOids } }).project({ title: 1 }).toArray()
      : [];
  const titleById = new Map<string, string>(courses.map((c: any) => [c._id.toString(), String(c.title || 'Course')]));

  const masteryCourseIds = [
    ...new Set(
      mastery.map((m: any) => String(m.topicId || '').trim()).filter((id: string) => id && ObjectId.isValid(id))
    ),
  ].filter((id) => !titleById.has(id));
  if (masteryCourseIds.length > 0) {
    const extra = await db
      .collection('courses')
      .find({ _id: { $in: masteryCourseIds.map((id) => new ObjectId(id)) } })
      .project({ title: 1 })
      .toArray();
    for (const c of extra) {
      titleById.set(c._id.toString(), String((c as any).title || 'Course'));
    }
  }

  const topicLabel = (topicId: string) => {
    const id = String(topicId || '').trim();
    if (!id) return 'Topic';
    const t = titleById.get(id);
    if (t) return t;
    if (!ObjectId.isValid(id)) return id;
    return 'Course (removed or unavailable)';
  };

  const courseProgress = enrollments.map((e: any) => ({
    courseId: e.course,
    courseTitle: titleById.get(e.course) || 'Course',
    progress: Math.round(Number(e.progress) || 0),
    status: e.status || 'active',
  }));

  const avgProgress =
    enrollments.length > 0
      ? enrollments.reduce((s: number, e: any) => s + (e.progress || 0), 0) / enrollments.length
      : 0;

  const avgScore =
    submissions.length > 0
      ? submissions.reduce((s: number, sub: any) => s + (sub.percentage || 0), 0) / submissions.length
      : 0;

  const passRate =
    submissions.length > 0 ? (submissions.filter((s: any) => s.passed).length / submissions.length) * 100 : 0;

  const aiPracticeAvg =
    aiAttempts.length > 0
      ? Math.round(
          aiAttempts.reduce(
            (s: number, a: any) => s + (typeof a.percentage === 'number' ? a.percentage : 0),
            0
          ) / aiAttempts.length
        )
      : null;

  const cqAvg =
    courseQuizAttempts.length > 0
      ? Math.round(
          courseQuizAttempts.reduce(
            (s: number, a: any) => s + (typeof a.percentage === 'number' ? a.percentage : 0),
            0
          ) / courseQuizAttempts.length
        )
      : null;

  let blendedMcqScore: number | null = null;
  if (submissions.length > 0 && aiAttempts.length > 0) {
    blendedMcqScore = Math.round(avgScore * 0.55 + (aiPracticeAvg ?? 0) * 0.45);
  } else if (submissions.length > 0) {
    blendedMcqScore = Math.round(avgScore);
  } else if (aiAttempts.length > 0) {
    blendedMcqScore = aiPracticeAvg;
  }

  const scoreTrend = submissions.slice(-10).map((s: any) => ({
    assignmentId: s.assignmentId,
    score: s.percentage,
    date: s.submittedAt,
  }));

  const activityCounts: Record<string, number> = {};
  activities.forEach((a: any) => {
    activityCounts[a.type] = (activityCounts[a.type] || 0) + 1;
  });
  if (courseQuizAttempts.length) activityCounts['Lesson MCQs'] = courseQuizAttempts.length;
  if (aiAttempts.length) activityCounts['AI practice runs'] = aiAttempts.length;
  if (discussionThreads) activityCounts['Discussion threads'] = discussionThreads;
  if (interviewsCompleted) activityCounts['Interviews completed'] = interviewsCompleted;

  const masteryMap = mastery.map((m: any) => {
    const topicId = String(m.topicId ?? '');
    const level = typeof m.level === 'number' ? m.level : Number(m.level);
    const safeLevel = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    return {
      topicId,
      topicLabel: topicLabel(topicId),
      level: safeLevel,
      lastUpdated: m.lastUpdated,
    };
  });

  const weakAreas = masteryMap.filter(m => m.level < 0.5);

  const isAtRisk = avgProgress < 30 || avgScore < 40 || activities.length < 3;

  const recentCourseQuizAttempts = courseQuizAttempts.slice(0, 8).map((a: any) => ({
    courseId: a.courseId,
    lessonTitle: a.lessonTitle || 'Lesson',
    percentage: Math.round(Number(a.percentage) || 0),
    passed: !!a.passed,
    createdAt: a.createdAt,
  }));

  const recentSubmissions = submissions.slice(-6).map((s: any) => ({
    percentage: Math.round(Number(s.percentage) || 0),
    passed: !!s.passed,
    submittedAt: s.submittedAt,
  }));

  return {
    totalEnrollments: enrollments.length,
    avgProgress: Math.round(avgProgress),
    avgScore: Math.round(avgScore),
    passRate: Math.round(passRate),
    submissionsCount: submissions.length,
    certificatesEarned: certificates.length,
    scoreTrend,
    activityCounts,
    masteryLevels: masteryMap,
    weakAreas,
    aiQuizAttempts: aiAttempts.map((a: any) => ({
      id: a._id.toString(),
      topic: a.topic,
      score: a.score,
      percentage: a.percentage,
      totalQuestions: Array.isArray(a.questions) ? a.questions.length : 0,
      createdAt: a.createdAt,
      blurCount: a.session?.blurCount,
      mode: a.session?.mode,
    })),
    aiPracticeAvg,
    blendedMcqScore,
    isAtRisk,
    insightsProfile,
    courseProgress,
    courseQuizAttemptsCount: courseQuizAttempts.length,
    courseQuizAvg: cqAvg,
    recentCourseQuizAttempts,
    discussionThreads,
    interviewsCompleted,
    recentSubmissions,
  };
}

// ─── Student Analytics ────────────────────────────────────────────────────────
export async function getStudentAnalytics(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const analytics = await buildStudentAnalyticsPayload(userId);
    res.json({ success: true, analytics });
  } catch (e) {
    console.error('getStudentAnalytics', e);
    res.status(500).json({ success: false, message: 'Failed to load analytics' });
  }
}

export async function postStudentAnalyticsSummary(req: AuthRequest, res: Response) {
  try {
    if (req.user?.role !== 'student') {
      return res.status(403).json({
        success: false,
        message: 'AI learning summary is available for student accounts.',
      });
    }

    const analytics = await buildStudentAnalyticsPayload(req.user!.id);
    const ip = analytics.insightsProfile;

    const learnerContext = ip
      ? `
Learner-provided context (from profile):
- Career / study goal: ${ip.careerOrStudyGoal || '—'}
- Weekly study time: ${ip.weeklyStudyHours || '—'}
- Subjects of interest: ${ip.subjectsOfInterest || '—'}
- Learning challenges: ${ip.learningChallenges || '—'}
- Preferred formats: ${ip.preferredFormats || '—'}
`
      : 'No extra learner profile filled in yet.';

    const progressLines = (analytics.courseProgress || [])
      .map((c: any) => `- ${c.courseTitle}: ${c.progress}% (${c.status})`)
      .join('\n');

    const prompt = `You are CAROA, an educational coach. Write a concise, supportive learning summary for ONE student.

Platform metrics:
- Enrolled courses: ${analytics.totalEnrollments}
- Average course progress: ${analytics.avgProgress}%
- Assignment / course MCQ avg score: ${analytics.avgScore}% (from ${analytics.submissionsCount} submissions)
- Pass rate on submissions: ${analytics.passRate}%
- Certificates earned: ${analytics.certificatesEarned}
- Lesson MCQ attempts (in-video quizzes): ${analytics.courseQuizAttemptsCount}, avg ${analytics.courseQuizAvg ?? 'n/a'}%
- AI practice quiz runs: ${analytics.aiQuizAttempts?.length || 0}, avg AI score: ${analytics.aiPracticeAvg ?? 'n/a'}%
- Blended MCQ signal: ${analytics.blendedMcqScore ?? 'n/a'}%
- Discussion threads started: ${analytics.discussionThreads}
- Practice interviews completed: ${analytics.interviewsCompleted}
- At-risk flag (low engagement): ${analytics.isAtRisk ? 'yes' : 'no'}

Per-course progress:
${progressLines || 'None'}

Weak topic areas (mastery < 50%): ${analytics.weakAreas.map((w: any) => w.topicLabel || w.topicId).join(', ') || 'None listed'}

${learnerContext}

Respond with ONLY valid JSON (no markdown fences) in this shape:
{
  "headline": "short encouraging title",
  "summary": "2-4 sentences tying metrics to actions",
  "strengths": ["bullet", "bullet"],
  "focusAreas": ["bullet", "bullet"],
  "thisWeek": ["one concrete action", "one concrete action", "one concrete action"]
}`;

    try {
      const completion = await groqCompletion({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.45,
        max_tokens: 900,
      });

      const text = completion.choices[0]?.message?.content || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : {
            headline: 'Your learning snapshot',
            summary: 'Keep engaging with your courses and use AI practice to reinforce weak topics.',
            strengths: [],
            focusAreas: [],
            thisWeek: ['Review one weak topic', 'Complete one lesson quiz', 'Submit pending assignments'],
          };

      res.json({
        success: true,
        summary: {
          headline: String(parsed.headline || 'Learning summary'),
          summary: String(parsed.summary || ''),
          strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
          focusAreas: Array.isArray(parsed.focusAreas) ? parsed.focusAreas.map(String) : [],
          thisWeek: Array.isArray(parsed.thisWeek) ? parsed.thisWeek.map(String) : [],
        },
      });
    } catch {
      res.json({
        success: true,
        summary: {
          headline: 'Your learning snapshot',
          summary: `You are enrolled in ${analytics.totalEnrollments} course(s) with ${analytics.avgProgress}% average progress and ${analytics.avgScore}% average assignment score.`,
          strengths: analytics.passRate >= 70 ? ['Solid submission pass rate'] : [],
          focusAreas: analytics.isAtRisk ? ['Increase weekly activity and lesson completion'] : ['Keep pushing on weak topics'],
          thisWeek: [
            'Skim course outlines for upcoming deadlines',
            'Run one AI practice quiz on your weakest topic',
            analytics.discussionThreads < 1 ? 'Ask one question in a course discussion' : 'Reply to a peer in discussions',
          ],
        },
      });
    }
  } catch (e) {
    console.error('postStudentAnalyticsSummary', e);
    res.status(500).json({ success: false, message: 'Failed to generate summary' });
  }
}

// ─── Instructor Course Analytics ──────────────────────────────────────────────
export async function getCourseAnalytics(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const db = getDB();

    const [enrollments, submissions, reviews, discussions, liveClasses] = await Promise.all([
      db.collection('enrollments').find({ course: courseId }).toArray(),
      db.collection('submissions').find({ courseId }).toArray(),
      db.collection('reviews').find({ courseId }).toArray(),
      db.collection('discussions').find({ courseId }).toArray(),
      db.collection('liveclasses').find({ courseId }).toArray(),
    ]);

    const avgScore = submissions.length > 0
      ? submissions.reduce((s: number, sub: any) => s + (sub.percentage || 0), 0) / submissions.length
      : 0;

    const avgProgress = enrollments.length > 0
      ? enrollments.reduce((s: number, e: any) => s + (e.progress || 0), 0) / enrollments.length
      : 0;

    const avgRating = reviews.length > 0
      ? reviews.reduce((s: number, r: any) => s + r.rating, 0) / reviews.length
      : 0;

    const completionRate = enrollments.length > 0
      ? (enrollments.filter((e: any) => e.status === 'completed').length / enrollments.length) * 100
      : 0;

    // At-risk students (progress < 20% or no activity in 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const atRiskStudents = enrollments.filter((e: any) =>
      (e.progress || 0) < 20 || (e.lastAccessed && new Date(e.lastAccessed) < sevenDaysAgo)
    ).length;

    // Score distribution
    const distribution = { excellent: 0, good: 0, average: 0, poor: 0 };
    submissions.forEach((s: any) => {
      if (s.percentage >= 80) distribution.excellent++;
      else if (s.percentage >= 60) distribution.good++;
      else if (s.percentage >= 40) distribution.average++;
      else distribution.poor++;
    });

    res.json({
      success: true,
      analytics: {
        totalEnrollments: enrollments.length,
        completionRate: Math.round(completionRate),
        avgProgress: Math.round(avgProgress),
        avgScore: Math.round(avgScore),
        avgRating: Math.round(avgRating * 10) / 10,
        totalReviews: reviews.length,
        totalSubmissions: submissions.length,
        totalDiscussions: discussions.length,
        totalLiveClasses: liveClasses.length,
        atRiskStudents,
        scoreDistribution: distribution,
      },
    });
  } catch (e) {
    console.error('getCourseAnalytics', e);
    res.status(500).json({ success: false, message: 'Failed to load analytics' });
  }
}

// ─── Platform Analytics (Admin) ────────────────────────────────────────────────
export async function getPlatformAnalytics(req: AuthRequest, res: Response) {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }

    const db = getDB();
    const [users, courses, enrollments, submissions, certificates] = await Promise.all([
      db.collection('users').countDocuments(),
      db.collection('courses').countDocuments({ status: 'published' }),
      db.collection('enrollments').countDocuments(),
      db.collection('submissions').countDocuments(),
      db.collection('certificates').countDocuments(),
    ]);

    const studentCount = await db.collection('users').countDocuments({ role: 'student' });
    const instructorCount = await db.collection('users').countDocuments({ role: 'instructor' });

    res.json({
      success: true,
      analytics: {
        totalUsers: users,
        students: studentCount,
        instructors: instructorCount,
        publishedCourses: courses,
        totalEnrollments: enrollments,
        totalSubmissions: submissions,
        certificatesIssued: certificates,
      },
    });
  } catch (e) {
    console.error('getPlatformAnalytics', e);
    res.status(500).json({ success: false, message: 'Failed to load analytics' });
  }
}

// ─── AI-Generated Insights for Instructor ─────────────────────────────────────
export async function getAIInsights(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const db = getDB();

    const [enrollments, submissions, reviews] = await Promise.all([
      db.collection('enrollments').find({ course: courseId }).toArray(),
      db.collection('submissions').find({ courseId }).limit(50).toArray(),
      db.collection('reviews').find({ courseId }).toArray(),
    ]);

    const avgScore = submissions.length > 0
      ? submissions.reduce((s: number, sub: any) => s + (sub.percentage || 0), 0) / submissions.length : 0;
    const avgProgress = enrollments.length > 0
      ? enrollments.reduce((s: number, e: any) => s + (e.progress || 0), 0) / enrollments.length : 0;
    const completions = enrollments.filter((e: any) => e.status === 'completed').length;
    const avgRating = reviews.length > 0
      ? reviews.reduce((s: number, r: any) => s + r.rating, 0) / reviews.length : 0;

    const prompt = `Analyze this online course data and provide actionable insights for the instructor:

Course Statistics:
- Total Enrollments: ${enrollments.length}
- Average Student Progress: ${Math.round(avgProgress)}%
- Average Quiz Score: ${Math.round(avgScore)}%
- Completion Rate: ${enrollments.length > 0 ? Math.round((completions / enrollments.length) * 100) : 0}%
- Average Rating: ${Math.round(avgRating * 10) / 10}/5
- Total Reviews: ${reviews.length}
- At-risk Students (progress < 20%): ${enrollments.filter((e: any) => (e.progress || 0) < 20).length}

Provide a JSON response with this structure:
{
  "summary": "2-3 sentence overview",
  "strengths": ["strength 1", "strength 2"],
  "improvements": ["improvement 1", "improvement 2"],
  "atRiskActions": ["action 1 for at-risk students"],
  "recommendations": ["specific recommendation 1", "recommendation 2"]
}`;

    try {
      const completion = await groqCompletion({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.4,
        max_tokens: 800,
      });

      const text = completion.choices[0]?.message?.content || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const insights = jsonMatch ? JSON.parse(jsonMatch[0]) : {
        summary: 'Analysis complete.',
        strengths: [], improvements: [], atRiskActions: [], recommendations: []
      };

      res.json({ success: true, insights });
    } catch {
      res.json({
        success: true,
        insights: {
          summary: `Your course has ${enrollments.length} enrollments with ${Math.round(avgProgress)}% average progress.`,
          strengths: avgScore > 70 ? ['Students are performing well on assessments'] : [],
          improvements: avgProgress < 50 ? ['Consider adding more engaging content to boost progress'] : [],
          atRiskActions: ['Reach out to students with < 20% progress', 'Review difficult quiz questions'],
          recommendations: ['Add more real-world examples', 'Consider adding live sessions'],
        }
      });
    }
  } catch (e) {
    console.error('getAIInsights', e);
    res.status(500).json({ success: false, message: 'Failed to generate insights' });
  }
}

// ─── CAROA: Personalized Recommendations ──────────────────────────────────────
export async function getCAROARecommendations(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    const userId = req.user!.id;
    const oid = ObjectId.isValid(userId) ? new ObjectId(userId) : null;

    const [enrollments, submissions, mastery, allCourses, userMini] = await Promise.all([
      db.collection('enrollments').find({ student: userId }).toArray(),
      db.collection('submissions').find({ studentId: userId }).sort({ submittedAt: -1 }).limit(20).toArray(),
      db.collection('mastery').find({ userId }).toArray(),
      db.collection('courses').find({ status: 'published' }).toArray(),
      oid ? db.collection('users').findOne({ _id: oid }, { projection: { insightsProfile: 1 } }) : Promise.resolve(null),
    ]);

    const ip = (userMini?.insightsProfile || {}) as IInsightsProfile;
    const profileLines = [
      ip.careerOrStudyGoal && `Goal: ${ip.careerOrStudyGoal}`,
      ip.weeklyStudyHours && `Weekly study time: ${ip.weeklyStudyHours}`,
      ip.subjectsOfInterest && `Interests: ${ip.subjectsOfInterest}`,
      ip.learningChallenges && `Challenges: ${ip.learningChallenges}`,
      ip.preferredFormats && `Preferred formats: ${ip.preferredFormats}`,
    ]
      .filter(Boolean)
      .join('\n');

    const enrolledCourseIds = new Set(enrollments.map((e: any) => e.course));
    const unenrolledCourses = allCourses.filter(c => !enrolledCourseIds.has(c._id.toString()));

    if (unenrolledCourses.length === 0) {
      return res.json({ success: true, recommendations: [], message: 'Enrolled in all available courses' });
    }

    const avgScore = submissions.length > 0
      ? submissions.reduce((s: number, sub: any) => s + (sub.percentage || 0), 0) / submissions.length : 0;

    const weakTopicLabels = mastery
      .filter((m: any) => (typeof m.level === 'number' ? m.level : Number(m.level)) < 0.5)
      .map((m: any) => {
        const id = String(m.topicId || '');
        const c = allCourses.find((x: any) => x._id.toString() === id);
        return c ? String(c.title || 'Course') : id;
      });

    const courseList = unenrolledCourses.slice(0, 10).map(c => ({
      id: c._id.toString(),
      title: c.title,
      category: c.category,
      difficulty: c.difficulty,
    }));

    const prompt = `CAROA AI Engine - Generate personalized course recommendations.

Student Profile:
- Enrolled courses: ${enrollments.length}
- Average assessment score: ${Math.round(avgScore)}%
- Weak areas (low mastery — course/topic names): ${weakTopicLabels.join(', ') || 'None identified yet'}
- Recent activity: ${submissions.length} submissions
${profileLines ? `- Learner context (from settings):\n${profileLines}` : '- Learner context: not filled in profile yet'}

Available courses to recommend:
${courseList.map((c, i) => `${i + 1}. ${c.title} (${c.category}, ${c.difficulty})`).join('\n')}

Return JSON: {
  "recommendations": [
    {"courseId": "id", "title": "title", "reason": "why this course", "priority": 1-5, "matchScore": 0.0-1.0}
  ]
}
Priority 1 is highest. Include top 3-5 recommendations.`;

    try {
      const completion = await groqCompletion({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.3,
        max_tokens: 600,
      });

      const text = completion.choices[0]?.message?.content || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { recommendations: [] };

      // Map back with full course data
      const recs = (result.recommendations || []).map((r: any) => {
        const course = unenrolledCourses.find(c => c._id.toString() === r.courseId || c.title === r.title);
        return {
          courseId: course?._id.toString() || r.courseId,
          title: course?.title || r.title,
          category: course?.category || '',
          difficulty: course?.difficulty || '',
          thumbnail: course?.thumbnail,
          reason: r.reason,
          priority: r.priority,
          matchScore: r.matchScore,
        };
      }).filter((r: any) => r.courseId);

      res.json({ success: true, recommendations: recs });
    } catch {
      // Fallback: recommend highest rated unenrolled courses
      const fallback = unenrolledCourses.slice(0, 3).map(c => ({
        courseId: c._id.toString(),
        title: c.title,
        category: c.category,
        difficulty: c.difficulty,
        thumbnail: c.thumbnail,
        reason: 'Recommended based on your learning profile',
        priority: 1,
        matchScore: 0.7,
      }));
      res.json({ success: true, recommendations: fallback });
    }
  } catch (e) {
    console.error('getCAROARecommendations', e);
    res.status(500).json({ success: false, message: 'Failed to generate recommendations' });
  }
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function utcMondayStart(reference: Date): Date {
  const d = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  const dow = d.getUTCDay();
  const delta = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + delta);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dayIndexMondayBased(ts: Date, weekStart: Date): number {
  const diffMs = new Date(ts).getTime() - weekStart.getTime();
  const idx = Math.floor(diffMs / 86400000);
  if (idx < 0 || idx > 6) return -1;
  return idx;
}

function activityMinutesWeight(type: string | undefined): number {
  switch (type) {
    case 'assignment_submission':
      return 14;
    case 'ai_quiz_attempt':
      return 12;
    case 'live_class_attendance':
      return 22;
    default:
      return 5;
  }
}

/** GET /api/analytics/weekly-activity — chart data for dashboard (current UTC week Mon–Sun). */
export async function getWeeklyActivity(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const role = req.user!.role;
    const db = getDB();
    const now = new Date();
    const weekStart = utcMondayStart(now);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 7);

    const minutes = [0, 0, 0, 0, 0, 0, 0];

    if (role === 'instructor' || role === 'admin') {
      const courses = await db
        .collection('courses')
        .find({ $or: [{ instructorId: userId }, { instructor: userId }] })
        .project({ _id: 1 })
        .toArray();
      const courseIds = courses.map((c: any) => c._id.toString());

      if (courseIds.length > 0) {
        const assigns = await db
          .collection('assignments')
          .find({ courseId: { $in: courseIds }, status: 'active' })
          .project({ _id: 1 })
          .toArray();
        const assignmentIds = assigns.map((a: any) => a._id.toString());
        if (assignmentIds.length > 0) {
          const subs = await db
            .collection('submissions')
            .find({
              assignmentId: { $in: assignmentIds },
              submittedAt: { $gte: weekStart, $lt: weekEnd },
            })
            .toArray();
          subs.forEach((s: any) => {
            const idx = dayIndexMondayBased(new Date(s.submittedAt), weekStart);
            if (idx >= 0) minutes[idx] += 8;
          });
        }
      }

      const ownActs = await db
        .collection('activity')
        .find({ userId, timestamp: { $gte: weekStart, $lt: weekEnd } })
        .toArray();
      ownActs.forEach((a: any) => {
        const idx = dayIndexMondayBased(new Date(a.timestamp), weekStart);
        if (idx >= 0) minutes[idx] += activityMinutesWeight(a.type);
      });
    } else {
      const acts = await db
        .collection('activity')
        .find({ userId, timestamp: { $gte: weekStart, $lt: weekEnd } })
        .toArray();
      acts.forEach((a: any) => {
        const idx = dayIndexMondayBased(new Date(a.timestamp), weekStart);
        if (idx >= 0) minutes[idx] += activityMinutesWeight(a.type);
      });

      const cq = await db
        .collection('courseQuizAttempts')
        .find({ userId, createdAt: { $gte: weekStart, $lt: weekEnd } })
        .toArray();
      cq.forEach((q: any) => {
        const idx = dayIndexMondayBased(new Date(q.createdAt), weekStart);
        if (idx >= 0) {
          const n = Array.isArray(q.questions) ? q.questions.length : 4;
          minutes[idx] += Math.min(18, 4 + n);
        }
      });

      const ivs = await db
        .collection('interviewSessions')
        .find({
          userId,
          status: 'completed',
          completedAt: { $gte: weekStart, $lt: weekEnd },
        })
        .toArray();
      ivs.forEach((iv: any) => {
        const idx = dayIndexMondayBased(new Date(iv.completedAt), weekStart);
        if (idx >= 0) minutes[idx] += 18;
      });
    }

    const days = WEEKDAY_LABELS.map((day, i) => ({
      day,
      minutes: Math.round(minutes[i]),
    }));

    res.json({
      success: true,
      weekStart: weekStart.toISOString(),
      weekEndExclusive: weekEnd.toISOString(),
      days,
    });
  } catch (e) {
    console.error('getWeeklyActivity', e);
    res.status(500).json({ success: false, message: 'Failed to load weekly activity' });
  }
}

// ─── At-Risk Student Detection ────────────────────────────────────────────────
export async function getAtRiskStudents(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    if (req.user?.role !== 'instructor' && req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Instructor access required' });
    }

    const db = getDB();
    const enrollments = await db.collection('enrollments').find({ course: courseId }).toArray();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const atRiskStudentIds = enrollments
      .filter((e: any) => (e.progress || 0) < 25 || (e.lastAccessed && new Date(e.lastAccessed) < sevenDaysAgo))
      .map((e: any) => e.student);

    if (atRiskStudentIds.length === 0) {
      return res.json({ success: true, atRiskStudents: [], count: 0 });
    }

    const users = await db.collection('users').find({
      _id: {
        $in: atRiskStudentIds.map((id: string) => { try { return new ObjectId(id); } catch { return null; } })
          .filter((x: any): x is ObjectId => x !== null)
      }
    }).toArray();

    const studentMap = new Map(users.map(u => [u._id.toString(), u]));
    const atRiskStudents = enrollments
      .filter((e: any) => atRiskStudentIds.includes(e.student))
      .map((e: any) => ({
        studentId: e.student,
        name: studentMap.get(e.student)?.name || 'Unknown',
        email: studentMap.get(e.student)?.email || '',
        progress: e.progress || 0,
        lastAccessed: e.lastAccessed,
        riskLevel: (e.progress || 0) < 10 ? 'high' : 'medium',
      }));

    res.json({ success: true, atRiskStudents, count: atRiskStudents.length });
  } catch (e) {
    console.error('getAtRiskStudents', e);
    res.status(500).json({ success: false, message: 'Failed to detect at-risk students' });
  }
}
