import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';
import { groqCompletion, getGroqKeyStatus } from '../lib/groqClient.js';

const SYLLABUS_MAX = 18_000;
const COURSE_OUTLINE_MAX = 14_000;

function truncate(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated]`;
}

function buildCourseOutline(course: any): string {
  const lines: string[] = [];
  lines.push(`Title: ${course.title || 'Course'}`);
  lines.push(`Category: ${course.category || ''} · Level: ${course.difficulty || course.level || ''}`);
  lines.push(`Description:\n${String(course.description || '').slice(0, 2000)}`);
  const modules = Array.isArray(course.modules) ? course.modules : [];
  modules.forEach((mod: any, mi: number) => {
    lines.push(`\n--- Module ${mi + 1}: ${mod.title || 'Untitled'} ---`);
    const lessons = Array.isArray(mod.lessons) ? mod.lessons : [];
    lessons.forEach((les: any, li: number) => {
      const title = les.title || les.name || `Lesson ${li + 1}`;
      const content = String(les.content || '').replace(/\s+/g, ' ').slice(0, 500);
      lines.push(`· ${title}${content ? ` — ${content}` : ''}`);
    });
  });
  return truncate(lines.join('\n'), COURSE_OUTLINE_MAX);
}

function parseAnalysisJson(text: string): Record<string, unknown> {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return {
      overallMatchPercent: null,
      summary: text.slice(0, 1200),
      stronglyAligned: [],
      inSyllabusNotInCourse: [],
      inCourseNotInSyllabus: [],
      suggestionsForStudent: [],
      parseError: true,
    };
  }
}

/** Student (enrolled) or course owner / admin can compare syllabus to course outline. */
export async function postSyllabusMatch(req: AuthRequest, res: Response) {
  try {
    if (!getGroqKeyStatus().configured) {
      return res.status(503).json({ success: false, message: 'Syllabus match requires GROQ_API_KEY on the server' });
    }

    const { id: courseId } = req.params;
    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    let syllabusText = String((req.body as any)?.syllabusText || '').trim();
    const file = req.file as Express.Multer.File | undefined;
    if (file?.buffer) {
      const name = (file.originalname || '').toLowerCase();
      const ok =
        /\.(txt|md)$/i.test(name) ||
        file.mimetype === 'text/plain' ||
        file.mimetype === 'text/markdown';
      if (!ok) {
        return res.status(400).json({
          success: false,
          message: 'Upload a .txt or .md syllabus (or paste text). PDF is not supported yet.',
        });
      }
      const fromFile = file.buffer.toString('utf8').trim();
      syllabusText = [syllabusText, fromFile].filter(Boolean).join('\n\n').trim();
    }

    syllabusText = truncate(syllabusText, SYLLABUS_MAX);
    if (!syllabusText) {
      return res.status(400).json({
        success: false,
        message: 'Provide syllabus text or upload a .txt / .md file.',
      });
    }

    const db = getDB();
    const course = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const ownerId = String((course as any).instructorId ?? (course as any).instructor ?? '');
    const isOwner = ownerId === req.user!.id;
    const isAdmin = req.user!.role === 'admin';
    const enrollment = await db.collection('enrollments').findOne({
      student: req.user!.id,
      course: String(courseId),
    });

    if (!enrollment && !isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Enroll in this course to use syllabus match' });
    }

    const outline = buildCourseOutline(course);

    const prompt = `You compare an external syllabus to this platform course outline. Be honest: the syllabus may use different wording than the course.

COURSE OUTLINE (authoritative for what this course actually contains):
${outline}

EXTERNAL SYLLABUS (student-provided):
${syllabusText}

Return ONLY valid JSON (no markdown code fences) with this exact shape:
{
  "overallMatchPercent": <integer 0-100, estimated how much of the syllabus learning outcomes/topics are reasonably covered by this course>,
  "summary": "<2-4 sentences for the student>",
  "stronglyAligned": [
    { "syllabusTopic": "<short>", "courseLocation": "<module/lesson or course-level>", "confidence": "high"|"medium"|"low" }
  ],
  "inSyllabusNotInCourse": ["<bullet>", "..."],
  "inCourseNotInSyllabus": ["<bullet>", "..."],
  "suggestionsForStudent": ["<actionable study tip>", "..."]
}

Rules:
- overallMatchPercent is an estimate, not a guarantee.
- If the syllabus is vague, say so in summary and lower confidence.
- Keep arrays to max 8 items each; strings concise.`;

    const completion = await groqCompletion({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.25,
      max_tokens: 2200,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    const analysis = parseAnalysisJson(raw);

    res.json({
      success: true,
      courseTitle: (course as any).title || 'Course',
      analysis,
    });
  } catch (e: any) {
    console.error('postSyllabusMatch', e);
    res.status(500).json({ success: false, message: e?.message || 'Syllabus match failed' });
  }
}
