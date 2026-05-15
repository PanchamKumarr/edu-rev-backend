import { Router } from 'express';
import { signup, login, verifyToken, googleAuth } from '../controllers/authController.js';
import { updateInsightsProfile, getMyProfile, updateMyProfile } from '../controllers/userProfileController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Routes
router.post('/signup', signup);
router.post('/login', login);
router.post('/google', googleAuth);
router.get('/verify', verifyToken);
router.get('/profile', requireAuth, getMyProfile);
router.patch('/profile/insights', requireAuth, updateInsightsProfile);
router.patch('/profile', requireAuth, updateMyProfile);

export default router;
