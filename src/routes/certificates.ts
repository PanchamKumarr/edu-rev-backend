import { Router } from 'express';
import {
  generateCertificate,
  getCertificateEligibility,
  getMyCertificates,
  verifyCertificateGet,
  verifyCertificatePost,
  downloadCertificatePdf,
} from '../controllers/certificatesController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/my', requireAuth, getMyCertificates);
router.get('/eligibility/:courseId', requireAuth, getCertificateEligibility);
router.post('/generate/:courseId', requireAuth, generateCertificate);
router.post('/verify', verifyCertificatePost);
router.get('/pdf/:certId', downloadCertificatePdf);
router.get('/verify/:certId', verifyCertificateGet);

export default router;
