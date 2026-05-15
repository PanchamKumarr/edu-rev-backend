import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';
import { groqCompletion } from '../lib/groqClient.js';

// ─── Instructor: Create Assignment/Quiz ───────────────────────────────────────
export async function createAssignment(req: AuthRequest, res: Response) {
  try {
    const { courseId, title, description, type, questions, dueDate, maxScore, passingScore } = req.body;

    if (!courseId || !title || !type) {
      return res.status(400).json({ success: false, message: 'courseId, title, and type are required' });
    }
    if (!ObjectId.isValid(String(courseId))) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }
    if (!['mcq', 'subjective', 'mixed'].includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be mcq, subjective, or mixed' });
    }
    if (req.user?.role !== 'instructor' && req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only instructors can create assignments' });
    }

    const db = getDB();
    const course = await db.collection('courses').findOne({ _id: new ObjectId(String(courseId)) });
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }
    const ownerId = String((course as any).instructorId ?? (course as any).instructor ?? '');
    if (ownerId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'You can only add assignments to your own courses' });
    }

    const qs = Array.isArray(questions) ? questions : [];
    if (qs.length === 0) {
      return res.status(400).json({ success: false, message: 'Add at least one question' });
    }

    const now = new Date();
    const doc = {
      courseId: String(courseId),
      instructorId: req.user!.id,
      title: title.trim(),
      description: description?.trim() || '',
      type,
      questions: qs,
      dueDate: dueDate ? new Date(dueDate) : null,
      maxScore: Number(maxScore) || 100,
      passingScore: Number(passingScore) || 50,
      status: 'active',
      submissionCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('assignments').insertOne(doc);
    const assignmentIdStr = result.insertedId.toString();

    await db.collection('courses').updateOne(
      { _id: new ObjectId(String(courseId)) },
      { $addToSet: { assignmentIds: assignmentIdStr }, $set: { updatedAt: now } }
    );

    // Notify enrolled students
    const enrollments = await db.collection('enrollments').find({ course: String(courseId) }).toArray();
    const notifications = enrollments.map((e: any) => ({
      userId: e.student,
      type: 'assignment',
      title: 'New Assignment Posted',
      message: `"${title}" has been posted for your course`,
      read: false,
      link: `/dashboard`,
      createdAt: now,
    }));
    if (notifications.length > 0) await db.collection('notifications').insertMany(notifications);

    res.status(201).json({ success: true, message: 'Assignment created', assignmentId: result.insertedId.toString() });
  } catch (e) {
    console.error('createAssignment', e);
    res.status(500).json({ success: false, message: 'Failed to create assignment' });
  }
}

// ─── Get Assignments for a Course ─────────────────────────────────────────────
export async function getAssignments(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.query;
    if (!courseId) return res.status(400).json({ success: false, message: 'courseId is required' });
    if (!ObjectId.isValid(String(courseId))) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    const db = getDB();
    const course = await db.collection('courses').findOne({ _id: new ObjectId(String(courseId)) });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const userId = req.user!.id;
    const role = req.user!.role;
    const ownerId = String((course as any).instructorId ?? (course as any).instructor ?? '');

    if (role === 'admin') {
      /* ok */
    } else if (role === 'instructor') {
      if (ownerId !== userId) {
        return res.status(403).json({ success: false, message: 'Not authorized to view assignments for this course' });
      }
    } else {
      const enr = await db.collection('enrollments').findOne({ student: userId, course: String(courseId) });
      if (!enr) {
        return res.status(403).json({ success: false, message: 'Enroll in this course to view assignments' });
      }
    }

    const docs = await db.collection('assignments')
      .find({ courseId: String(courseId), status: 'active' })
      .sort({ createdAt: -1 })
      .toArray();

    const courseTitle = String((course as any).title || '').trim() || 'Course';

    let assignments = docs.map(mapAssignment);

    if (role !== 'admin' && role !== 'instructor') {
      const assignmentIds = docs.map((d: any) => d._id.toString());
      const submissions = await db.collection('submissions')
        .find({ studentId: userId, assignmentId: { $in: assignmentIds } })
        .toArray();
      const submissionMap = new Map(submissions.map((s: any) => [s.assignmentId, s]));
      assignments = assignments.map((a: any) => {
        const s = submissionMap.get(a.id);
        if (!s) return { ...a, submission: null, courseTitle };
        return {
          ...a,
          courseTitle,
          submission: {
            id: s._id.toString(),
            score: s.score,
            status: s.status,
            submittedAt: s.submittedAt,
            feedback: s.feedback,
            percentage: s.percentage,
            passed: s.passed,
          },
        };
      });
    } else {
      assignments = assignments.map((a: any) => ({ ...a, courseTitle }));
    }

    res.json({ success: true, assignments });
  } catch (e) {
    console.error('getAssignments', e);
    res.status(500).json({ success: false, message: 'Failed to load assignments' });
  }
}

// ─── Get All Assignments for a Student (enrolled courses) ─────────────────────
export async function getMyAssignments(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    const userId = req.user!.id;
    const role = req.user!.role;

    // Instructors/admins: assignments they created (not tied to student enrollment)
    if (role === 'instructor' || role === 'admin') {
      const filter: Record<string, unknown> = { instructorId: userId, status: 'active' };
      const { courseId } = req.query;
      if (courseId && ObjectId.isValid(String(courseId))) {
        filter.courseId = String(courseId);
      }
      const docs = await db.collection('assignments')
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      const withTitles = await attachCourseTitles(db, docs.map((d: any) => mapAssignment(d)));
      return res.json({ success: true, assignments: withTitles });
    }

    const enrollments = await db.collection('enrollments').find({ student: userId }).toArray();
    const courseIds = enrollments.map((e: any) => e.course);

    if (courseIds.length === 0) return res.json({ success: true, assignments: [] });

    const docs = await db.collection('assignments')
      .find({ courseId: { $in: courseIds }, status: 'active' })
      .sort({ dueDate: 1 })
      .toArray();

    // Attach submission status for each
    const assignmentIds = docs.map((d: any) => d._id.toString());
    const submissions = await db.collection('submissions')
      .find({ studentId: userId, assignmentId: { $in: assignmentIds } })
      .toArray();
    const submissionMap = new Map(submissions.map((s: any) => [s.assignmentId, s]));

    const assignments = await attachCourseTitles(
      db,
      docs.map((d: any) => ({
        ...mapAssignment(d),
        submission: submissionMap.get(d._id.toString()) ? {
          id: submissionMap.get(d._id.toString())!._id.toString(),
          score: submissionMap.get(d._id.toString())!.score,
          status: submissionMap.get(d._id.toString())!.status,
          submittedAt: submissionMap.get(d._id.toString())!.submittedAt,
          feedback: submissionMap.get(d._id.toString())!.feedback,
          percentage: submissionMap.get(d._id.toString())!.percentage,
          passed: submissionMap.get(d._id.toString())!.passed,
        } : null,
      }))
    );

    res.json({ success: true, assignments });
  } catch (e) {
    console.error('getMyAssignments', e);
    res.status(500).json({ success: false, message: 'Failed to load assignments' });
  }
}

// ─── Get Single Assignment ─────────────────────────────────────────────────────
export async function getAssignment(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const doc = await db.collection('assignments').findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ success: false, message: 'Assignment not found' });

    res.json({ success: true, assignment: mapAssignment(doc) });
  } catch (e) {
    console.error('getAssignment', e);
    res.status(500).json({ success: false, message: 'Failed to load assignment' });
  }
}

// ─── Student / instructor: full submission detail (per-question breakdown) ─────
export async function getStudentSubmission(req: AuthRequest, res: Response) {
  try {
    const { submissionId } = req.params;
    if (!ObjectId.isValid(submissionId)) {
      return res.status(400).json({ success: false, message: 'Invalid submission ID' });
    }

    const db = getDB();
    const sub = await db.collection('submissions').findOne({ _id: new ObjectId(submissionId) });
    if (!sub) return res.status(404).json({ success: false, message: 'Submission not found' });

    const assignment = await db.collection('assignments').findOne({ _id: new ObjectId(String(sub.assignmentId)) });
    if (!assignment || (assignment as any).status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }

    const userId = req.user!.id;
    const role = req.user!.role;
    const ownerId = String((assignment as any).instructorId ?? '');
    const isStudentOwner = sub.studentId === userId;
    const isInstructorOwner = ownerId === userId;

    if (role === 'admin') {
      /* ok */
    } else if (role === 'instructor') {
      if (!isInstructorOwner) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this submission' });
      }
    } else if (!isStudentOwner) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this submission' });
    }

    res.json({
      success: true,
      assignment: mapAssignment(assignment),
      submission: {
        id: sub._id.toString(),
        assignmentId: String(sub.assignmentId),
        courseId: String(sub.courseId),
        studentId: String(sub.studentId),
        answers: sub.answers || [],
        gradedAnswers: sub.gradedAnswers || [],
        score: sub.score,
        maxScore: sub.maxScore,
        percentage: sub.percentage,
        passed: sub.passed,
        feedback: sub.feedback || '',
        status: sub.status,
        submittedAt: sub.submittedAt,
        gradedAt: sub.gradedAt,
        aiReview: sub.aiReview ?? null,
      },
    });
  } catch (e) {
    console.error('getStudentSubmission', e);
    res.status(500).json({ success: false, message: 'Failed to load submission' });
  }
}

// ─── Submit Assignment ─────────────────────────────────────────────────────────
export async function submitAssignment(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const { answers } = req.body; // [{questionIndex, answer}]
    const userId = req.user!.id;

    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });
    if (!Array.isArray(answers)) return res.status(400).json({ success: false, message: 'answers array required' });

    const db = getDB();
    const assignment = await db.collection('assignments').findOne({ _id: new ObjectId(id) });
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found' });

    // Check due date (applies to first attempt and re-attempts)
    if (assignment.dueDate && new Date() > new Date(assignment.dueDate)) {
      return res.status(400).json({ success: false, message: 'Submission deadline has passed' });
    }

    const existing = await db.collection('submissions').findOne({ assignmentId: id, studentId: userId });
    if (existing) {
      const threshold = Number((assignment as any).passingScore) || 50;
      const prevPassed =
        (existing as any).passed === true ||
        (typeof (existing as any).score === 'number' && (existing as any).score >= threshold);
      if (prevPassed) {
        return res.status(409).json({
          success: false,
          message: 'You already passed this assignment.',
        });
      }
      await db.collection('submissions').deleteOne({ _id: (existing as any)._id });
      await db.collection('assignments').updateOne(
        { _id: new ObjectId(id), submissionCount: { $gt: 0 } },
        { $inc: { submissionCount: -1 } }
      );
    }

    const now = new Date();
    let score = 0;
    let feedback = '';
    let status = 'submitted';
    let gradedAnswers: any[] = [];
    let aiReview: {
      overallSummary: string;
      strengths: string[];
      improvements: string[];
      focusAreas: string[];
    } | null = null;

    const pointsPerQuestion = assignment.questions.length > 0
      ? assignment.maxScore / assignment.questions.length
      : 0;

    // Build per-answer grading rows
    if (assignment.type === 'mcq' || assignment.type === 'mixed') {
      let correct = 0;
      let mcqTotal = 0;
      gradedAnswers = answers.map((a: any) => {
        const q = assignment.questions[a.questionIndex];
        if (!q) return { ...a, isCorrect: false };
        if (q.type === 'mcq' || !q.type) {
          mcqTotal++;
          const isCorrect = a.answer === q.correctAnswer;
          if (isCorrect) correct++;
          return { ...a, isCorrect, correctAnswer: q.correctAnswer, explanation: q.explanation };
        }
        return { ...a, type: 'subjective' };
      });

      if (mcqTotal > 0) {
        score = Math.round(correct * pointsPerQuestion);
        feedback = `MCQ Score: ${correct}/${mcqTotal} correct. `;
      }
    } else if (assignment.type === 'subjective') {
      gradedAnswers = answers.map((a: any) => ({ ...a, type: 'subjective' }));
    }

    // AI-grade subjective answers
    const subjectiveAnswers = answers.filter((a: any) => {
      const q = assignment.questions[a.questionIndex];
      return q && (q.type === 'subjective' || assignment.type === 'subjective');
    });

    if (subjectiveAnswers.length > 0) {
      try {
        const subjectiveQuestions = subjectiveAnswers.map((a: any) => {
          const q = assignment.questions[a.questionIndex];
          return `Q${a.questionIndex + 1}: ${q.question}\nStudent Answer: ${a.answer}\nModel Answer: ${q.modelAnswer || 'Not provided'}`;
        }).join('\n\n');

        const prompt = `You are grading student work for the assignment titled "${assignment.title}".
Instructions from instructor: ${(assignment as any).description || 'None'}.

${subjectiveQuestions}

Return ONLY valid JSON (no markdown) with this exact shape:
{
  "grades": [{"questionIndex": 0, "score": 8, "feedback": "One or two sentences."}],
  "overallSummary": "2-4 sentences summarizing overall performance vs the assignment goals.",
  "whatYouDidWell": ["short bullet", "..."],
  "whatToImprove": ["short bullet", "..."],
  "focusNext": ["concrete study or practice actions the student should take next"]
}

Rules: score is 0-10 per subjective question (use questionIndex matching the Q numbers above minus 1). Be specific and constructive.`;

        const completion = await groqCompletion({
          messages: [{ role: 'user', content: prompt }],
          model: 'llama-3.3-70b-versatile',
          temperature: 0.3,
          max_tokens: 2048,
        });

        const text = completion.choices[0]?.message?.content || '{}';
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
          const grades = Array.isArray(parsed.grades) ? parsed.grades : [];

          let subjectiveScore = 0;
          grades.forEach((g: any) => {
            const qIdx = Number(g.questionIndex);
            const raw = Number(g.score);
            const sc = Number.isFinite(raw) ? Math.min(10, Math.max(0, raw)) : 0;
            subjectiveScore += (sc / 10) * pointsPerQuestion;
            feedback += `Q${qIdx + 1}: ${g.feedback ?? ''} `;

            const row = gradedAnswers.find((x: any) => Number(x.questionIndex) === qIdx);
            if (row) {
              Object.assign(row, {
                aiScore: sc,
                aiFeedback: String(g.feedback ?? ''),
                pointsAwarded: Math.round((sc / 10) * pointsPerQuestion),
              });
            }
          });
          score += Math.round(subjectiveScore);
          status = 'graded';

          const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
          aiReview = {
            overallSummary: typeof parsed.overallSummary === 'string' ? parsed.overallSummary : '',
            strengths: asList(parsed.whatYouDidWell),
            improvements: asList(parsed.whatToImprove),
            focusAreas: asList(parsed.focusNext),
          };
        } catch { /* keep as submitted */ }
      } catch { /* AI grading failed */ }
    }

    if (assignment.type === 'mcq') status = 'graded';

    const submissionDoc: Record<string, unknown> = {
      assignmentId: id,
      courseId: assignment.courseId,
      studentId: userId,
      answers,
      gradedAnswers,
      score,
      maxScore: assignment.maxScore,
      percentage: Math.round((score / assignment.maxScore) * 100),
      passed: score >= (assignment.passingScore || 50),
      feedback: feedback.trim(),
      status,
      submittedAt: now,
      gradedAt: status === 'graded' ? now : null,
    };
    if (aiReview) submissionDoc.aiReview = aiReview;

    const result = await db.collection('submissions').insertOne(submissionDoc);
    await db.collection('assignments').updateOne({ _id: new ObjectId(id) }, { $inc: { submissionCount: 1 } });

    // Update CAROA mastery based on score
    const percentage = submissionDoc.percentage as number;
    const masterLevel = percentage / 100;
    await db.collection('mastery').updateOne(
      { userId, topicId: assignment.courseId },
      { $set: { level: masterLevel, lastUpdated: now }, $inc: { attempts: 1 } },
      { upsert: true }
    );

    // Log activity
    await db.collection('activity').insertOne({
      userId, type: 'assignment_submission', assignmentId: id, score, timestamp: now
    });

    const submissionIdStr = result.insertedId.toString();

    // Notify student of grade
    if (status === 'graded') {
      await db.collection('notifications').insertOne({
        userId, type: 'grade', title: 'Assignment Graded',
        message: `Your submission for "${assignment.title}" scored ${score}/${assignment.maxScore}`,
        read: false,
        link: `/dashboard/assignments/result/${submissionIdStr}`,
        createdAt: now,
      });
    }

    res.status(201).json({
      success: true, message: 'Assignment submitted',
      submissionId: submissionIdStr,
      score, percentage: submissionDoc.percentage,
      passed: submissionDoc.passed, feedback: (submissionDoc.feedback as string).trim(), status,
      gradedAnswers,
      aiReview: aiReview || undefined,
    });
  } catch (e) {
    console.error('submitAssignment', e);
    res.status(500).json({ success: false, message: 'Failed to submit assignment' });
  }
}

// ─── Instructor: Update Assignment ─────────────────────────────────────────────
export async function updateAssignment(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid assignment ID' });
    }

    const db = getDB();
    const existing = await db.collection('assignments').findOne({ _id: new ObjectId(id) });
    if (!existing || (existing as any).status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }
    if ((existing as any).instructorId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to update this assignment' });
    }

    const { title, description, type, questions, dueDate, maxScore, passingScore } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (title !== undefined) {
      const t = String(title).trim();
      if (!t) return res.status(400).json({ success: false, message: 'Title cannot be empty' });
      updates.title = t;
    }
    if (description !== undefined) updates.description = String(description).trim();
    if (type !== undefined) {
      if (!['mcq', 'subjective', 'mixed'].includes(type)) {
        return res.status(400).json({ success: false, message: 'type must be mcq, subjective, or mixed' });
      }
      updates.type = type;
    }
    if (maxScore !== undefined) {
      const n = Number(maxScore);
      updates.maxScore = !Number.isNaN(n) && n > 0 ? n : (existing as any).maxScore;
    }
    if (passingScore !== undefined) {
      const n = Number(passingScore);
      updates.passingScore = !Number.isNaN(n) && n >= 0 ? n : (existing as any).passingScore;
    }
    if (dueDate !== undefined) {
      updates.dueDate = dueDate ? new Date(dueDate) : null;
    }
    if (questions !== undefined) {
      const qs = Array.isArray(questions) ? questions : [];
      if (qs.length === 0) {
        return res.status(400).json({ success: false, message: 'Add at least one question' });
      }
      updates.questions = qs;
    }

    if (Object.keys(updates).length <= 1) {
      return res.status(400).json({ success: false, message: 'No changes provided' });
    }

    await db.collection('assignments').updateOne({ _id: new ObjectId(id) }, { $set: updates });
    res.json({ success: true, message: 'Assignment updated' });
  } catch (e) {
    console.error('updateAssignment', e);
    res.status(500).json({ success: false, message: 'Failed to update assignment' });
  }
}

// ─── Instructor: Get Submissions for Assignment ────────────────────────────────
export async function getSubmissions(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid assignment ID' });
    }

    const db = getDB();
    const assignment = await db.collection('assignments').findOne({ _id: new ObjectId(id) });
    if (!assignment || (assignment as any).status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }
    if ((assignment as any).instructorId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to view submissions' });
    }

    const subs = await db.collection('submissions').find({ assignmentId: id }).sort({ submittedAt: -1 }).toArray();
    const studentIds = [...new Set(subs.map((s: any) => s.studentId))];
    const users = await db.collection('users').find({ _id: { $in: studentIds.map(sid => { try { return new ObjectId(sid); } catch { return null; } }).filter((x): x is ObjectId => x !== null) } }).toArray();
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    const submissions = subs.map((s: any) => ({
      id: s._id.toString(),
      studentId: s.studentId,
      studentName: userMap.get(s.studentId)?.name || 'Unknown',
      studentEmail: userMap.get(s.studentId)?.email || '',
      score: s.score,
      maxScore: s.maxScore,
      percentage: s.percentage,
      passed: s.passed,
      feedback: s.feedback,
      status: s.status,
      submittedAt: s.submittedAt,
    }));

    res.json({ success: true, submissions });
  } catch (e) {
    console.error('getSubmissions', e);
    res.status(500).json({ success: false, message: 'Failed to load submissions' });
  }
}

// ─── Instructor: Manual Grade Submission ──────────────────────────────────────
export async function gradeSubmission(req: AuthRequest, res: Response) {
  try {
    const { submissionId } = req.params;
    const { score, feedback } = req.body;
    if (!ObjectId.isValid(submissionId)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const sub = await db.collection('submissions').findOne({ _id: new ObjectId(submissionId) });
    if (!sub) return res.status(404).json({ success: false, message: 'Submission not found' });

    const now = new Date();
    const percentage = Math.round((Number(score) / sub.maxScore) * 100);
    await db.collection('submissions').updateOne({ _id: new ObjectId(submissionId) }, {
      $set: { score: Number(score), percentage, passed: percentage >= 50, feedback, status: 'graded', gradedAt: now }
    });

    await db.collection('notifications').insertOne({
      userId: sub.studentId, type: 'grade', title: 'Assignment Graded',
      message: `Your assignment was graded. Score: ${score}/${sub.maxScore}`,
      read: false, link: '/dashboard', createdAt: now,
    });

    res.json({ success: true, message: 'Graded successfully' });
  } catch (e) {
    console.error('gradeSubmission', e);
    res.status(500).json({ success: false, message: 'Failed to grade' });
  }
}

// ─── Delete Assignment ─────────────────────────────────────────────────────────
export async function deleteAssignment(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });

    const db = getDB();
    const existing = await db.collection('assignments').findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ success: false, message: 'Assignment not found' });
    if (existing.instructorId !== req.user!.id && req.user!.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    await db.collection('assignments').updateOne({ _id: new ObjectId(id) }, { $set: { status: 'deleted', updatedAt: new Date() } });

    const cid = String((existing as any).courseId || '');
    if (cid && ObjectId.isValid(cid)) {
      await db.collection('courses').updateOne(
        { _id: new ObjectId(cid) },
        { $pull: { assignmentIds: id } as any, $set: { updatedAt: new Date() } }
      );
    }

    res.json({ success: true, message: 'Assignment deleted' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to delete' });
  }
}

function mapAssignment(d: any) {
  return {
    id: d._id.toString(),
    courseId: d.courseId,
    instructorId: d.instructorId,
    title: d.title,
    description: d.description,
    type: d.type,
    questions: d.questions || [],
    dueDate: d.dueDate,
    maxScore: d.maxScore,
    passingScore: d.passingScore,
    submissionCount: d.submissionCount || 0,
    createdAt: d.createdAt,
  };
}

/** Adds courseTitle from courses collection for dashboard grouping. */
async function attachCourseTitles<T extends { courseId?: string }>(
  db: ReturnType<typeof getDB>,
  items: T[]
): Promise<Array<T & { courseTitle: string }>> {
  const ids = [...new Set(items.map((x) => String(x.courseId || '')).filter((id) => ObjectId.isValid(id)))];
  if (ids.length === 0) {
    return items.map((x) => ({ ...x, courseTitle: 'Course' }));
  }
  const courseDocs = await db
    .collection('courses')
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
    .project({ title: 1 })
    .toArray();
  const titleMap = new Map(
    courseDocs.map((c: any) => [c._id.toString(), String(c.title || '').trim() || 'Course'])
  );
  return items.map((x) => ({
    ...x,
    courseTitle: titleMap.get(String(x.courseId)) || 'Course',
  }));
}
