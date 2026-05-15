import { Response } from 'express';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

function generateCertId(): string {
  return 'EDU-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function normalizeCertId(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

function normalizePersonName(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Same pass rule as submitAssignment: score >= assignment.passingScore (points threshold). */
async function getPendingAssignmentsForCertificate(
  db: ReturnType<typeof getDB>,
  userId: string,
  courseId: string,
): Promise<{ pending: { assignmentId: string; title: string }[] }> {
  const assignDocs = await db
    .collection('assignments')
    .find({ courseId: String(courseId), status: 'active' })
    .toArray();

  const pending: { assignmentId: string; title: string }[] = [];

  for (const raw of assignDocs) {
    const a = raw as any;
    const aid = a._id.toString();
    const threshold = Number(a.passingScore ?? 50);

    const sub = await db.collection('submissions').findOne(
      { studentId: userId, assignmentId: aid },
      { sort: { submittedAt: -1 } },
    );

    if (!sub) {
      pending.push({ assignmentId: aid, title: String(a.title || 'Assignment') });
      continue;
    }

    const s = sub as any;
    const passed = s.passed === true || (typeof s.score === 'number' && s.score >= threshold);
    if (!passed) {
      pending.push({ assignmentId: aid, title: String(a.title || 'Assignment') });
    }
  }

  return { pending };
}

export async function getCertificateEligibility(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;
    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    const db = getDB();
    const enrollment = await db.collection('enrollments').findOne({ student: userId, course: courseId });
    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Not enrolled in this course' });
    }

    const existingCert = await db.collection('certificates').findOne({ userId, courseId });
    const progress = Number(enrollment.progress) || 0;
    const progressOk = progress >= 100;
    const { pending } = await getPendingAssignmentsForCertificate(db, userId, courseId);
    const assignmentsOk = pending.length === 0;

    res.json({
      success: true,
      progress,
      progressOk,
      pendingAssignments: pending,
      assignmentsOk,
      canGenerate: !existingCert && progressOk && assignmentsOk,
      alreadyIssued: !!existingCert,
    });
  } catch (e) {
    console.error('getCertificateEligibility', e);
    res.status(500).json({ success: false, message: 'Failed to check certificate eligibility' });
  }
}

// ─── Generate Certificate on Course Completion ───────────────────────────────
export async function generateCertificate(req: AuthRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user!.id;

    const db = getDB();

    const enrollment = await db.collection('enrollments').findOne({ student: userId, course: courseId });
    if (!enrollment) return res.status(404).json({ success: false, message: 'Not enrolled in this course' });

    const existing = await db.collection('certificates').findOne({ userId, courseId });
    if (existing) {
      return res.json({ success: true, certificate: mapCert(existing), alreadyIssued: true });
    }

    const progress = Number(enrollment.progress) || 0;
    if (progress < 100) {
      return res.status(400).json({
        success: false,
        message: 'Complete 100% of course lessons before generating your certificate.',
        progress,
      });
    }

    const { pending } = await getPendingAssignmentsForCertificate(db, userId, courseId);
    if (pending.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Pass all required course assignments before generating your certificate.',
        pendingAssignments: pending,
      });
    }

    if (!ObjectId.isValid(courseId)) return res.status(400).json({ success: false, message: 'Invalid course ID' });
    const course = await db.collection('courses').findOne({ _id: new ObjectId(courseId) });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    if (!ObjectId.isValid(userId)) return res.status(400).json({ success: false, message: 'Invalid user ID' });
    const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const now = new Date();
    const certId = generateCertId();

    const certDoc = {
      certId,
      userId,
      userName: user.name,
      courseId,
      courseTitle: course.title,
      instructorId: course.instructorId || '',
      issuedAt: now,
      verificationUrl: `/api/certificates/verify/${certId}`,
      qrData: `${process.env.CLIENT_URL || 'http://localhost:3000'}/verify/${certId}`,
      progress: enrollment.progress || 100,
    };

    await db.collection('certificates').insertOne(certDoc);

    await db.collection('enrollments').updateOne(
      { student: userId, course: courseId },
      { $set: { status: 'completed', completedAt: now, progress: 100 } }
    );

    await db.collection('notifications').insertOne({
      userId,
      type: 'certificate',
      title: 'Certificate Issued!',
      message: `Congratulations! You've earned a certificate for "${course.title}"`,
      read: false,
      link: '/dashboard',
      createdAt: now,
    });

    res.status(201).json({ success: true, certificate: mapCert(certDoc), message: 'Certificate generated!' });
  } catch (e) {
    console.error('generateCertificate', e);
    res.status(500).json({ success: false, message: 'Failed to generate certificate' });
  }
}

export async function getMyCertificates(req: AuthRequest, res: Response) {
  try {
    const db = getDB();
    const docs = await db.collection('certificates').find({ userId: req.user!.id }).sort({ issuedAt: -1 }).toArray();
    res.json({ success: true, certificates: docs.map(mapCert) });
  } catch (e) {
    console.error('getMyCertificates', e);
    res.status(500).json({ success: false, message: 'Failed to load certificates' });
  }
}

/** POST body: { certId, recipientName } — checks record exists and name matches (case-insensitive). */
export async function verifyCertificatePost(req: any, res: Response) {
  try {
    const certId = normalizeCertId(req.body?.certId);
    const recipientName = typeof req.body?.recipientName === 'string' ? req.body.recipientName : '';
    if (!certId) return res.status(400).json({ success: false, message: 'Certificate ID is required' });
    if (!recipientName.trim()) {
      return res.status(400).json({ success: false, message: 'Recipient name is required for verification' });
    }

    const db = getDB();
    const cert = await db.collection('certificates').findOne({ certId });
    if (!cert) {
      return res.status(404).json({
        success: false,
        valid: false,
        certificateFound: false,
        nameMatch: false,
        message: 'No certificate found with this ID.',
      });
    }

    const expected = normalizePersonName(cert.userName);
    const given = normalizePersonName(recipientName);
    const nameMatch = expected === given && given.length > 0;

    if (!nameMatch) {
      return res.json({
        success: true,
        valid: false,
        certificateFound: true,
        nameMatch: false,
        message: 'A certificate with this ID exists, but the recipient name does not match our records.',
      });
    }

    res.json({
      success: true,
      valid: true,
      certificateFound: true,
      nameMatch: true,
      certificate: mapCert(cert),
      message: 'This certificate is genuine.',
    });
  } catch (e) {
    console.error('verifyCertificatePost', e);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
}

/** GET — public lookup by ID (no name check). Optional ?recipientName= adds nameMatch in response. */
export async function verifyCertificateGet(req: any, res: Response) {
  try {
    const certId = normalizeCertId(req.params.certId);
    if (!certId) return res.status(400).json({ success: false, message: 'Invalid certificate ID' });

    const db = getDB();
    const cert = await db.collection('certificates').findOne({ certId });
    if (!cert) {
      return res.status(404).json({ success: false, valid: false, message: 'Certificate not found or invalid' });
    }

    const recipientName = typeof req.query.recipientName === 'string' ? req.query.recipientName : '';
    let nameMatch: boolean | null = null;
    if (recipientName.trim()) {
      nameMatch = normalizePersonName(cert.userName) === normalizePersonName(recipientName);
    }

    res.json({
      success: true,
      valid: true,
      nameMatch,
      certificate: mapCert(cert),
    });
  } catch (e) {
    console.error('verifyCertificateGet', e);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
}

/** PDF download — requires recipientName query matching issued name (prevents ID-only scraping). */
export async function downloadCertificatePdf(req: any, res: Response) {
  try {
    const certId = normalizeCertId(req.params.certId);
    const recipientName = typeof req.query.recipientName === 'string' ? req.query.recipientName : '';
    if (!certId) return res.status(400).json({ success: false, message: 'Invalid certificate ID' });
    if (!recipientName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Query parameter recipientName is required and must match the certificate holder.',
      });
    }

    const db = getDB();
    const cert = await db.collection('certificates').findOne({ certId });
    if (!cert) return res.status(404).json({ success: false, message: 'Certificate not found' });

    if (normalizePersonName(cert.userName) !== normalizePersonName(recipientName)) {
      return res.status(403).json({ success: false, message: 'Recipient name does not match this certificate.' });
    }

    const pdfBuffer = await renderCertificatePdf(cert);
    const safeFile = `EDU-REV-${certId.replace(/[^A-Z0-9-]/gi, '')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('downloadCertificatePdf', e);
    res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
}

async function renderCertificatePdf(cert: any): Promise<Buffer> {
  const client = process.env.CLIENT_URL || 'http://localhost:3000';
  const verifyUrl = `${client}/verify/${encodeURIComponent(cert.certId)}`;

  const qrPng = await QRCode.toBuffer(verifyUrl, {
    type: 'png',
    width: 400,
    margin: 1,
    errorCorrectionLevel: 'H',
    color: { dark: '#1e1b4b', light: '#ffffff' },
  });

  const doc = new PDFDocument({
    size: 'LETTER',
    layout: 'landscape',
    margin: 0,
    info: { Title: 'Certificate of Completion', Author: 'EDU-REV', Subject: cert.courseTitle },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const W = doc.page.width;
  const H = doc.page.height;
  const pad = 40;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2;

  // Background gradient
  const bg = doc.linearGradient(0, 0, W, H);
  bg.stop(0, '#0c0a14').stop(0.45, '#12101f').stop(1, '#1a1530');
  doc.rect(0, 0, W, H).fill(bg);

  // Outer ornamental frame (gold)
  doc.save();
  doc.lineWidth(2.5).strokeColor('#c9a227');
  doc.roundedRect(pad, pad, innerW, innerH, 14).stroke();
  doc.lineWidth(1).strokeColor('#6366f1').opacity(0.9);
  doc.roundedRect(pad + 10, pad + 10, innerW - 20, innerH - 20, 10).stroke();
  doc.restore();

  // Corner accents (triangles)
  const tri = (x: number, y: number, dir: 'tl' | 'tr' | 'bl' | 'br') => {
    doc.save();
    doc.fillColor('#6366f1').opacity(0.5);
    if (dir === 'tl') doc.moveTo(x, y).lineTo(x + 26, y).lineTo(x, y + 26).closePath().fill();
    if (dir === 'tr') doc.moveTo(x, y).lineTo(x - 26, y).lineTo(x, y + 26).closePath().fill();
    if (dir === 'bl') doc.moveTo(x, y).lineTo(x + 26, y).lineTo(x, y - 26).closePath().fill();
    if (dir === 'br') doc.moveTo(x, y).lineTo(x - 26, y).lineTo(x, y - 26).closePath().fill();
    doc.restore();
  };
  tri(pad + 14, pad + 14, 'tl');
  tri(W - pad - 14, pad + 14, 'tr');
  tri(pad + 14, H - pad - 14, 'bl');
  tri(W - pad - 14, H - pad - 14, 'br');

  const contentX = pad + 36;
  const contentW = W - pad * 2 - 36 - 220;
  let y = pad + 36;

  // Brand row
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#a5b4fc').text('EDU-REV', contentX, y);
  doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('Verified learning credential', contentX + 72, y + 1);
  y += 36;

  // Title
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#94a3b8').text('CERTIFICATE OF COMPLETION', contentX, y, {
    width: contentW,
  });
  y += 22;

  doc.font('Helvetica-Bold').fontSize(34).fillColor('#f8fafc').text('Certificate of Completion', contentX, y, {
    width: contentW,
    lineGap: 2,
  });
  y += 52;

  // Decorative rule
  doc.save();
  doc.strokeColor('#c9a227').lineWidth(1.2);
  doc.moveTo(contentX, y).lineTo(contentX + Math.min(420, contentW * 0.75), y).stroke();
  doc.restore();
  y += 28;

  doc.font('Helvetica').fontSize(13).fillColor('#cbd5e1').text('This is to certify that', contentX, y, { width: contentW });
  y += 22;

  doc.font('Helvetica-Bold').fontSize(28).fillColor('#ffffff').text(String(cert.userName || 'Recipient'), contentX, y, {
    width: contentW,
  });
  y += 40;

  doc.font('Helvetica').fontSize(13).fillColor('#94a3b8').text('has successfully completed the course', contentX, y, { width: contentW });
  y += 22;

  doc.font('Helvetica-Bold').fontSize(20).fillColor('#e2e8f0').text(`“${String(cert.courseTitle || '')}”`, contentX, y, {
    width: contentW,
    lineGap: 4,
  });
  y += 48;

  const issued = cert.issuedAt
    ? new Date(cert.issuedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  doc.font('Helvetica').fontSize(11).fillColor('#64748b').text(`Issued on ${issued}`, contentX, y, { width: contentW });
  y += 36;

  // Signature line aesthetic
  doc.strokeColor('#475569').lineWidth(0.6);
  doc.moveTo(contentX, y).lineTo(contentX + 200, y).stroke();
  doc.font('Helvetica').fontSize(8).fillColor('#64748b').text('Program credential', contentX, y + 6);

  // Right panel — QR & meta
  const panelX = W - pad - 200;
  const qrSize = 132;
  const qrX = panelX + (200 - qrSize) / 2;
  const qrY = pad + 52;

  doc.save();
  doc.fillColor('#0f172a').strokeColor('#475569').lineWidth(0.8);
  doc.roundedRect(panelX - 8, qrY - 12, 200, qrSize + 88, 10).fillAndStroke();
  doc.restore();

  doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

  doc.font('Helvetica-Bold').fontSize(8).fillColor('#94a3b8').text('SCAN TO VERIFY', panelX, qrY + qrSize + 10, {
    width: 200,
    align: 'center',
  });
  doc.font('Helvetica').fontSize(7).fillColor('#64748b').text('Authenticity check', panelX, qrY + qrSize + 22, {
    width: 200,
    align: 'center',
  });

  doc.font('Helvetica').fontSize(8).fillColor('#cbd5e1').text(cert.certId, panelX, qrY + qrSize + 40, {
    width: 200,
    align: 'center',
  });

  // Footer bar
  const footY = H - pad - 36;
  doc.save();
  const footGrad = doc.linearGradient(0, footY, W, footY + 36);
  footGrad.stop(0, '#1e1b4b').stop(1, '#312e81');
  doc.rect(pad + 10, footY, innerW - 20, 32).fill(footGrad);
  doc.restore();

  doc.font('Helvetica').fontSize(8).fillColor('#c7d2fe').text(
    `Certificate ID  ·  ${cert.certId}  ·  Verify at ${verifyUrl}`,
    pad + 24,
    footY + 11,
    { width: innerW - 48, align: 'center' }
  );

  doc.font('Helvetica').fontSize(7).fillColor('#64748b').text(
    'This credential was issued by EDU-REV. Altered or forged documents are void.',
    pad + 20,
    H - pad - 14,
    { width: innerW - 40, align: 'center' }
  );

  doc.end();
  return done;
}

function mapCert(d: any) {
  return {
    id: d._id?.toString(),
    certId: d.certId,
    userId: d.userId,
    userName: d.userName,
    courseId: d.courseId,
    courseTitle: d.courseTitle,
    issuedAt: d.issuedAt,
    verificationUrl: d.verificationUrl,
    qrData: d.qrData,
  };
}
