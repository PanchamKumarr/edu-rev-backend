import { Router } from 'express';
import {
  listMyEnrollments,
  getCourseEnrollments,
  enrollInCourse,
  unenrollFromCourse,
  updateProgress,
  checkEnrollment,
} from '../controllers/enrollmentsController.js';
import {
  listCourseQuizAttempts,
  saveCourseQuizAttempt,
  getCourseQuizAttempt,
  analyzeQuizHistoryWithAI,
} from '../controllers/courseQuizController.js';
import { getPersonalLessonNote, savePersonalLessonNote } from '../controllers/lessonPersonalNotesController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, listMyEnrollments);
router.get('/course/:courseId/students', requireAuth, getCourseEnrollments);
router.post('/', requireAuth, enrollInCourse);
router.get('/check/:courseId', requireAuth, checkEnrollment);
router.get('/:courseId/personal-notes/:lessonId', requireAuth, getPersonalLessonNote);
router.put('/:courseId/personal-notes/:lessonId', requireAuth, savePersonalLessonNote);
router.get('/:courseId/quiz-attempts/:attemptId', requireAuth, getCourseQuizAttempt);
router.get('/:courseId/quiz-attempts', requireAuth, listCourseQuizAttempts);
router.post('/:courseId/quiz-attempts', requireAuth, saveCourseQuizAttempt);
router.post('/:courseId/quiz-ai-insights', requireAuth, analyzeQuizHistoryWithAI);
router.delete('/:courseId', requireAuth, unenrollFromCourse);
router.put('/:courseId/progress', requireAuth, updateProgress);

export default router;
