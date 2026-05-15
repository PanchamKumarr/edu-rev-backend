import { Router } from 'express';
import {
  listInstructorInsightCourses,
  listAllInstructorStudents,
  getStudentCourseInsight,
  postStudentCourseAiSummary,
} from '../controllers/instructorInsightsController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/students', requireAuth, listAllInstructorStudents);
router.get('/courses', requireAuth, listInstructorInsightCourses);
router.get('/courses/:courseId/students/:studentId', requireAuth, getStudentCourseInsight);
router.post('/courses/:courseId/students/:studentId/ai-summary', requireAuth, postStudentCourseAiSummary);

export default router;
