import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  getAdminStats,
  listAllUsers,
  updateUser,
  deleteUser,
  listAllCourses,
  deleteCourse,
  updateCourseStatus,
  listAllPayments,
  listAllCertificates,
  getRecentActivity,
} from '../controllers/adminController.js';

const router = Router();

// All admin routes require authentication (role check is inside each handler)
router.use(requireAuth);

router.get('/stats', getAdminStats);
router.get('/activity', getRecentActivity);

router.get('/users', listAllUsers);
router.patch('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);

router.get('/courses', listAllCourses);
router.patch('/courses/:id', updateCourseStatus);
router.delete('/courses/:id', deleteCourse);

router.get('/payments', listAllPayments);
router.get('/certificates', listAllCertificates);

export default router;
