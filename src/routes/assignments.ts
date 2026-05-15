import { Router } from 'express';
import {
  createAssignment, getAssignments, getMyAssignments, getAssignment, getStudentSubmission,
  submitAssignment, getSubmissions, gradeSubmission, deleteAssignment, updateAssignment,
} from '../controllers/assignmentsController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/my', requireAuth, getMyAssignments);
router.get('/', requireAuth, getAssignments);
router.post('/', requireAuth, createAssignment);
router.put('/submissions/:submissionId/grade', requireAuth, gradeSubmission);
router.get('/submissions/:submissionId', requireAuth, getStudentSubmission);
router.get('/:id', requireAuth, getAssignment);
router.put('/:id', requireAuth, updateAssignment);
router.post('/:id/submit', requireAuth, submitAssignment);
router.get('/:id/submissions', requireAuth, getSubmissions);
router.delete('/:id', requireAuth, deleteAssignment);

export default router;
