import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';
import { groqCompletion, getGroqKeyStatus } from '../lib/groqClient.js';

async function assertInstructorOwnsCourse(
  db: ReturnType<typeof getDB>,
  courseId: string,
  userId: string,
  role: string
): Promise<{ ok: true; course: any } | { ok: false; status: number; message: string }> {
  if (!ObjectId.isValid(courseId)) {
    return { ok: false, status: 400, message: 'Invalid course ID' };
  }
  const course = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
  if (!course) return { ok: false, status: 404, message: 'Course not found' };
  const owner = String((course as any).instructorId ?? (course as any).instructor ?? '');
  if (owner !== userId && role !== 'admin') {
    return { ok: false, status: 403, message: 'Not authorized for this course' };
  }
  return { ok: true, course };
}

export async function listInstructorInsightCourses(req: AuthRequest, res: Response) {
  try {
    if (req.user?.role !== 'instructor' && req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Instructors only' });
    }
    const db = getDB();
    const filter = req.user!.role === 'admin' ? {} : { instructorId: req.user!.id };
    const courses = await db.collection('courses').find(filter).project({ title: 1 }).sort({ createdAt: -1 }).toArray();
    const out = await Promise.all(
      courses.map(async (c: any) => {
        const cid = c._id.toString();
        const enrollmentCount = await db.collection('enrollments').countDocuments({ course: cid });
        return { id: cid, title: c.title || 'Untitled', enrollmentCount };
      })
    );
    res.json({ success: true, courses: out });
  } catch (e) {
    console.error('listInstructorInsightCourses', e);
    res.status(500).json({ success: false, message: 'Failed to load courses' });
  }
}

function avgPercentages(docs: any[]): number | null {
  const nums = docs.map((d) => Number(d.percentage)).filter((n) => !Number.isNaN(n));
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/** All students enrolled in any of the instructor's courses, with aggregate performance. */
export async function listAllInstructorStudents(req: AuthRequest, res: Response) {
  try {
    if (req.user?.role !== 'instructor' && req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Instructors only' });
    }
    const db = getDB();
    const courseFilter = req.user!.role === 'admin' ? {} : { instructorId: req.user!.id };
    const courses = await db
      .collection('courses')
      .find(courseFilter)
      .project({ _id: 1, title: 1 })
      .sort({ createdAt: -1 })
      .toArray();

    const courseIds = courses.map((c: any) => c._id.toString());
    const courseTitleById = new Map(courseIds.map((id, i) => [id, String(courses[i].title || 'Untitled')]));

    if (!courseIds.length) {
      return res.json({ success: true, students: [], courses: [] });
    }

    const enrollments = await db.collection('enrollments').find({ course: { $in: courseIds } }).toArray();
    const countByCourse = new Map<string, number>();
    for (const e of enrollments) {
      const cid = String((e as any).course);
      countByCourse.set(cid, (countByCourse.get(cid) || 0) + 1);
    }

    const courseMeta = courses.map((c: any) => ({
      id: c._id.toString(),
      title: c.title || 'Untitled',
      enrollmentCount: countByCourse.get(c._id.toString()) || 0,
    }));

    const studentIdSet = new Set<string>();
    for (const e of enrollments) studentIdSet.add(String((e as any).student));
    const allStudentIds = [...studentIdSet];

    if (!allStudentIds.length) {
      return res.json({ success: true, students: [], courses: courseMeta });
    }

    const validOids = allStudentIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    const users = validOids.length ? await db.collection('users').find({ _id: { $in: validOids } }).toArray() : [];
    const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

    const enrolByStudent = new Map<string, any[]>();
    for (const e of enrollments) {
      const sid = String((e as any).student);
      if (!enrolByStudent.has(sid)) enrolByStudent.set(sid, []);
      enrolByStudent.get(sid)!.push(e);
    }

    const [cqAll, aiAll, assignDocs, ivAgg] = await Promise.all([
      db
        .collection('courseQuizAttempts')
        .find({ courseId: { $in: courseIds }, userId: { $in: allStudentIds } })
        .project({ userId: 1, percentage: 1, courseId: 1 })
        .limit(12_000)
        .toArray(),
      db
        .collection('aiQuizAttempts')
        .find({ userId: { $in: allStudentIds } })
        .project({ userId: 1, percentage: 1 })
        .limit(12_000)
        .toArray(),
      db
        .collection('assignments')
        .find({ courseId: { $in: courseIds }, status: 'active' })
        .project({ _id: 1, courseId: 1 })
        .toArray(),
      db
        .collection('interviewSessions')
        .aggregate<{ _id: string; count: number }>([
          { $match: { userId: { $in: allStudentIds }, status: 'completed' } },
          { $group: { _id: '$userId', count: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const ivCountByUser = new Map(ivAgg.map((x) => [String(x._id), x.count]));
    const assignmentIds = assignDocs.map((a: any) => a._id.toString());
    const subsAll =
      assignmentIds.length > 0
        ? await db
            .collection('submissions')
            .find({ studentId: { $in: allStudentIds }, assignmentId: { $in: assignmentIds } })
            .project({ studentId: 1, passed: 1 })
            .limit(20_000)
            .toArray()
        : [];

    const cqByUser = new Map<string, any[]>();
    for (const d of cqAll) {
      const u = String((d as any).userId);
      if (!cqByUser.has(u)) cqByUser.set(u, []);
      cqByUser.get(u)!.push(d);
    }
    const aiByUser = new Map<string, any[]>();
    for (const d of aiAll) {
      const u = String((d as any).userId);
      if (!aiByUser.has(u)) aiByUser.set(u, []);
      aiByUser.get(u)!.push(d);
    }
    const subsByUser = new Map<string, any[]>();
    for (const s of subsAll) {
      const u = String((s as any).studentId);
      if (!subsByUser.has(u)) subsByUser.set(u, []);
      subsByUser.get(u)!.push(s);
    }

    const studentsOut = allStudentIds.map((sid) => {
      const enrols = enrolByStudent.get(sid) || [];
      const cq = cqByUser.get(sid) || [];
      const ai = aiByUser.get(sid) || [];
      const subs = subsByUser.get(sid) || [];
      const passed = subs.filter((x: any) => x.passed === true).length;
      const avgProgress =
        enrols.length > 0
          ? Math.round(enrols.reduce((acc, e: any) => acc + (Number(e.progress) || 0), 0) / enrols.length)
          : 0;

      const u = userMap.get(sid) as any;
      return {
        studentId: sid,
        name: u?.name || u?.email || 'Student',
        email: u?.email || '',
        enrollments: enrols.map((e: any) => ({
          courseId: String(e.course),
          courseTitle: courseTitleById.get(String(e.course)) || 'Course',
          progress: Number(e.progress) || 0,
          enrolledAt: e.enrolledAt,
        })),
        stats: {
          courseCount: enrols.length,
          avgProgress,
          lessonQuizAttempts: cq.length,
          lessonQuizAvgPercent: avgPercentages(cq),
          aiPracticeAttempts: ai.length,
          aiPracticeAvgPercent: avgPercentages(ai),
          assignmentSubmissions: subs.length,
          assignmentPassed: passed,
          interviewsCompleted: ivCountByUser.get(sid) || 0,
        },
      };
    });

    studentsOut.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, students: studentsOut, courses: courseMeta });
  } catch (e) {
    console.error('listAllInstructorStudents', e);
    res.status(500).json({ success: false, message: 'Failed to load students' });
  }
}

function mapCourseQuizAttempt(d: any) {
  return {
    id: d._id.toString(),
    lessonId: d.lessonId,
    lessonTitle: d.lessonTitle || '',
    score: d.score,
    total: Array.isArray(d.questions) ? d.questions.length : 0,
    percentage: d.percentage,
    passed: !!d.passed,
    createdAt: d.createdAt,
  };
}

function mapAiAttempt(d: any) {
  return {
    id: d._id.toString(),
    topic: d.topic || 'AI quiz',
    difficulty: d.difficulty || '',
    score: d.score,
    totalQuestions: Array.isArray(d.questions) ? d.questions.length : 0,
    percentage: d.percentage,
    analysis: typeof d.analysis === 'string' ? d.analysis.slice(0, 400) : '',
    createdAt: d.createdAt,
  };
}

function mapSubmission(s: any, assignmentTitle: string) {
  return {
    id: s._id.toString(),
    assignmentId: s.assignmentId,
    assignmentTitle,
    score: s.score,
    maxScore: s.maxScore,
    percentage: s.percentage,
    passed: s.passed,
    status: s.status,
    submittedAt: s.submittedAt,
    feedback: typeof s.feedback === 'string' ? s.feedback.slice(0, 500) : '',
  };
}

function mapInterviewSession(d: any) {
  const rub = d.rubric && typeof d.rubric === 'object' ? d.rubric : {};
  return {
    id: d._id.toString(),
    topic: d.topic || '',
    status: d.status || 'active',
    userTurnCount: d.userTurnCount ?? 0,
    overallScore: (rub as any).overallScore ?? null,
    communicationScore: (rub as any).communicationScore ?? null,
    technicalScore: (rub as any).technicalScore ?? null,
    summary: typeof d.evaluationSummary === 'string' ? d.evaluationSummary.slice(0, 700) : '',
    strengths: Array.isArray((rub as any).strengths) ? (rub as any).strengths.slice(0, 6) : [],
    improvements: Array.isArray((rub as any).improvements) ? (rub as any).improvements.slice(0, 6) : [],
    completedAt: d.completedAt || null,
    createdAt: d.createdAt,
  };
}

export async function getStudentCourseInsight(req: AuthRequest, res: Response) {
  try {
    const { courseId, studentId } = req.params;
    const db = getDB();
    const auth = await assertInstructorOwnsCourse(db, courseId, req.user!.id, req.user!.role);
    if (!auth.ok) return res.status(auth.status).json({ success: false, message: auth.message });

    const enrollment = await db.collection('enrollments').findOne({ course: String(courseId), student: String(studentId) });
    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Student is not enrolled in this course' });
    }

    let studentUser: any = null;
    if (ObjectId.isValid(studentId)) {
      studentUser = await db.collection('users').findOne({ _id: new ObjectId(studentId) });
    }

    const courseQuizDocs = await db
      .collection('courseQuizAttempts')
      .find({ courseId: String(courseId), userId: String(studentId) })
      .sort({ createdAt: -1 })
      .limit(80)
      .toArray();

    const aiDocs = await db
      .collection('aiQuizAttempts')
      .find({ userId: String(studentId) })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const assignments = await db
      .collection('assignments')
      .find({ courseId: String(courseId), status: 'active' })
      .toArray();
    const assignmentMap = new Map(assignments.map((a: any) => [a._id.toString(), String(a.title || 'Assignment')]));
    const assignmentIds = [...assignmentMap.keys()];
    const submissionDocs =
      assignmentIds.length > 0
        ? await db
            .collection('submissions')
            .find({ studentId: String(studentId), assignmentId: { $in: assignmentIds } })
            .sort({ submittedAt: -1 })
            .toArray()
        : [];

    const interviewDocs = await db
      .collection('interviewSessions')
      .find({ userId: String(studentId) })
      .sort({ updatedAt: -1 })
      .limit(15)
      .toArray();

    const assignmentSubmissions = submissionDocs.map((s: any) =>
      mapSubmission(s, assignmentMap.get(String(s.assignmentId)) || 'Assignment')
    );

    res.json({
      success: true,
      course: { id: String(courseId), title: auth.course.title || 'Course' },
      student: {
        id: String(studentId),
        name: studentUser?.name || studentUser?.email || 'Student',
        email: studentUser?.email || '',
      },
      enrollment: {
        progress: typeof enrollment.progress === 'number' ? enrollment.progress : 0,
        completedModules: Array.isArray(enrollment.completedModules) ? enrollment.completedModules : [],
        enrolledAt: enrollment.enrolledAt,
        lastAccessed: enrollment.lastAccessed,
        status: enrollment.status || 'active',
      },
      courseQuizAttempts: courseQuizDocs.map(mapCourseQuizAttempt),
      aiMcqAttemptsOutsideCourse: aiDocs.map(mapAiAttempt),
      assignmentSubmissions,
      interviewSessions: interviewDocs.map(mapInterviewSession),
    });
  } catch (e) {
    console.error('getStudentCourseInsight', e);
    res.status(500).json({ success: false, message: 'Failed to load student insight' });
  }
}

function buildSummaryForAi(payload: {
  courseTitle: string;
  studentName: string;
  enrollment: any;
  courseQuizAttempts: any[];
  aiMcqAttemptsOutsideCourse: any[];
  assignmentSubmissions: any[];
  interviewAttempts: any[];
}): string {
  const lines: string[] = [];
  lines.push(`Course: ${payload.courseTitle}`);
  lines.push(`Student: ${payload.studentName}`);
  lines.push(`Course progress: ${payload.enrollment?.progress ?? 0}%`);
  lines.push(`Completed lesson/module markers: ${(payload.enrollment?.completedModules || []).length}`);
  lines.push('');
  lines.push('--- Lesson / course MCQs (inside this course) ---');
  if (!payload.courseQuizAttempts.length) lines.push('No recorded attempts.');
  else {
    payload.courseQuizAttempts.slice(0, 25).forEach((a, i) => {
      lines.push(
        `${i + 1}. ${a.lessonTitle || a.lessonId} | score ${a.score}/${a.total} (${a.percentage}%) passed=${a.passed} @ ${a.createdAt ? new Date(a.createdAt).toISOString().slice(0, 10) : ''}`
      );
    });
    if (payload.courseQuizAttempts.length > 25) lines.push(`... and ${payload.courseQuizAttempts.length - 25} more attempts`);
  }
  lines.push('');
  lines.push('--- AI MCQ practice (dashboard / outside structured course quizzes) ---');
  if (!payload.aiMcqAttemptsOutsideCourse.length) lines.push('No AI practice attempts logged.');
  else {
    payload.aiMcqAttemptsOutsideCourse.slice(0, 20).forEach((a, i) => {
      lines.push(
        `${i + 1}. topic="${a.topic}" diff=${a.difficulty || 'n/a'} | ${a.score}/${a.totalQuestions} (${a.percentage}%) @ ${a.createdAt ? new Date(a.createdAt).toISOString().slice(0, 10) : ''}`
      );
    });
  }
  lines.push('');
  lines.push('--- Course assignments ---');
  if (!payload.assignmentSubmissions.length) lines.push('No submissions for course assignments.');
  else {
    payload.assignmentSubmissions.forEach((s, i) => {
      lines.push(
        `${i + 1}. ${s.assignmentTitle} | ${s.score}/${s.maxScore} (${s.percentage}%) status=${s.status} passed=${s.passed}`
      );
    });
  }
  lines.push('');
  lines.push('--- AI mock interviews (spoken-style practice in dashboard) ---');
  if (!payload.interviewAttempts?.length) lines.push('No AI interview sessions logged.');
  else {
    payload.interviewAttempts.slice(0, 12).forEach((iv, i) => {
      const scoreBits = `overall=${iv.overallScore ?? 'n/a'} communication=${iv.communicationScore ?? 'n/a'} technical=${iv.technicalScore ?? 'n/a'}`;
      lines.push(
        `${i + 1}. topic="${iv.topic}" status=${iv.status} studentReplies=${iv.userTurnCount} | ${scoreBits} @ ${iv.completedAt ? new Date(iv.completedAt).toISOString().slice(0, 10) : 'in progress'}`
      );
      if (iv.summary) lines.push(`   summary: ${String(iv.summary).slice(0, 500)}`);
      if (iv.strengths?.length) lines.push(`   strengths: ${iv.strengths.join('; ').slice(0, 400)}`);
      if (iv.improvements?.length) lines.push(`   improvements: ${iv.improvements.join('; ').slice(0, 400)}`);
    });
  }
  return lines.join('\n').slice(0, 12_000);
}

export async function postStudentCourseAiSummary(req: AuthRequest, res: Response) {
  try {
    const { courseId, studentId } = req.params;
    const db = getDB();
    const auth = await assertInstructorOwnsCourse(db, courseId, req.user!.id, req.user!.role);
    if (!auth.ok) return res.status(auth.status).json({ success: false, message: auth.message });

    if (!getGroqKeyStatus().configured) {
      return res.status(503).json({ success: false, message: 'AI summaries require GROQ_API_KEY on the server' });
    }

    const enrollment = await db.collection('enrollments').findOne({ course: String(courseId), student: String(studentId) });
    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Student is not enrolled in this course' });
    }

    let studentUser: any = null;
    if (ObjectId.isValid(studentId)) {
      studentUser = await db.collection('users').findOne({ _id: new ObjectId(studentId) });
    }

    const courseQuizDocs = await db
      .collection('courseQuizAttempts')
      .find({ courseId: String(courseId), userId: String(studentId) })
      .sort({ createdAt: -1 })
      .limit(80)
      .toArray();

    const aiDocs = await db
      .collection('aiQuizAttempts')
      .find({ userId: String(studentId) })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const assignments = await db
      .collection('assignments')
      .find({ courseId: String(courseId), status: 'active' })
      .toArray();
    const assignmentMap = new Map(assignments.map((a: any) => [a._id.toString(), String(a.title || 'Assignment')]));
    const assignmentIds = [...assignmentMap.keys()];
    const submissionDocs =
      assignmentIds.length > 0
        ? await db
            .collection('submissions')
            .find({ studentId: String(studentId), assignmentId: { $in: assignmentIds } })
            .sort({ submittedAt: -1 })
            .toArray()
        : [];

    const interviewDocsForAi = await db
      .collection('interviewSessions')
      .find({ userId: String(studentId) })
      .sort({ updatedAt: -1 })
      .limit(15)
      .toArray();

    const courseTitle = auth.course.title || 'Course';
    const studentName = studentUser?.name || studentUser?.email || 'Student';

    const summaryBlock = buildSummaryForAi({
      courseTitle,
      studentName,
      enrollment: {
        progress: enrollment.progress,
        completedModules: enrollment.completedModules || [],
      },
      courseQuizAttempts: courseQuizDocs.map(mapCourseQuizAttempt),
      aiMcqAttemptsOutsideCourse: aiDocs.map(mapAiAttempt),
      assignmentSubmissions: submissionDocs.map((s: any) => mapSubmission(s, assignmentMap.get(String(s.assignmentId)) || 'Assignment')),
      interviewAttempts: interviewDocsForAi.map(mapInterviewSession),
    });

    const prompt = `You are an expert learning science coach helping a course instructor support one learner.

Use ONLY the data below. Do not invent enrollments, scores, or behaviors not evidenced by the data.

${summaryBlock}

Respond in Markdown with these sections:
## Overview (2–4 sentences)
## Strengths (bullet list, tied to data)
## Gaps or risks (bullet list)
## What the instructor can do (numbered, concrete teaching actions — prep, feedback, pacing, scaffolding, check-ins)
## Optional short messages (2 brief lines the instructor could paste to the student — encouraging, specific)

When AI mock interview data exists, weave communication / interview readiness into strengths or gaps where supported by that data.

Keep the tone professional and supportive. If data is sparse, say so and suggest what to observe next.`;

    const completion = await groqCompletion({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.35,
      max_tokens: 2200,
    });

    const markdown = completion.choices[0]?.message?.content?.trim() || '';
    if (!markdown) {
      return res.status(502).json({ success: false, message: 'Empty AI response' });
    }

    res.json({ success: true, markdown });
  } catch (e: any) {
    console.error('postStudentCourseAiSummary', e);
    const msg = e?.message || 'AI summary failed';
    res.status(500).json({ success: false, message: msg });
  }
}
