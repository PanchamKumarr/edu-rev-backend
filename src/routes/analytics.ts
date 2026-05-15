import { Router } from 'express';
import {
  getStudentAnalytics,
  postStudentAnalyticsSummary,
  getCourseAnalytics,
  getPlatformAnalytics,
  getAIInsights,
  getCAROARecommendations,
  getAtRiskStudents,
  getWeeklyActivity,
} from '../controllers/analyticsController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/me', requireAuth, getStudentAnalytics);
router.get('/weekly-activity', requireAuth, getWeeklyActivity);
router.post('/me/summary', requireAuth, postStudentAnalyticsSummary);
router.get('/platform', requireAuth, getPlatformAnalytics);
router.get('/recommendations', requireAuth, getCAROARecommendations);
router.get('/course/:courseId', requireAuth, getCourseAnalytics);
router.get('/course/:courseId/insights', requireAuth, getAIInsights);
router.get('/course/:courseId/at-risk', requireAuth, getAtRiskStudents);

export default router;
