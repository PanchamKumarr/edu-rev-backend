import { Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../db/connection.js';
import { AuthRequest } from '../middleware/auth.js';

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Admin access required' });
    return false;
  }
  return true;
}

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
export async function getAdminStats(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const [users, courses, enrollments, payments, certificates] = await Promise.all([
      db.collection('users').find({}, { projection: { role: 1, createdAt: 1 } }).toArray(),
      db.collection('courses').find({}, { projection: { enrollmentCount: 1, price: 1, isFree: 1, status: 1, createdAt: 1 } }).toArray(),
      db.collection('enrollments').countDocuments(),
      db.collection('orders').find({}, { projection: { amount: 1, status: 1 } }).toArray(),
      db.collection('certificates').countDocuments(),
    ]);

    const totalRevenue = payments
      .filter((p: any) => p.status === 'completed')
      .reduce((sum: number, p: any) => sum + (Number(p.amount) || 0), 0);

    const roleCount = users.reduce((acc: Record<string, number>, u: any) => {
      acc[u.role] = (acc[u.role] || 0) + 1;
      return acc;
    }, {});

    // Users registered in the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newUsersThisMonth = users.filter((u: any) => u.createdAt && new Date(u.createdAt) >= thirtyDaysAgo).length;

    res.json({
      success: true,
      stats: {
        totalUsers: users.length,
        students: roleCount.student || 0,
        instructors: roleCount.instructor || 0,
        admins: roleCount.admin || 0,
        newUsersThisMonth,
        totalCourses: courses.length,
        publishedCourses: courses.filter((c: any) => c.status === 'published').length,
        totalEnrollments: enrollments,
        totalRevenue,
        totalCertificates: certificates,
        pendingPayments: payments.filter((p: any) => p.status === 'pending').length,
      },
    });
  } catch (err) {
    console.error('adminStats error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── GET /api/admin/users ──────────────────────────────────────────────────────
export async function listAllUsers(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const search = String(req.query.search || '').trim();
    const roleFilter = String(req.query.role || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const skip = Number(req.query.skip) || 0;

    const query: Record<string, any> = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    if (roleFilter) query.role = roleFilter;

    const users = await db
      .collection('users')
      .find(query, {
        projection: { password: 0 },
        sort: { createdAt: -1 },
        skip,
        limit,
      })
      .toArray();

    const total = await db.collection('users').countDocuments(query);

    // Attach enrollment count per user
    const userIds = users.map((u: any) => u._id?.toString());
    const enrollmentCounts = await db
      .collection('enrollments')
      .aggregate([
        { $match: { studentId: { $in: userIds } } },
        { $group: { _id: '$studentId', count: { $sum: 1 } } },
      ])
      .toArray();
    const enrMap: Record<string, number> = {};
    enrollmentCounts.forEach((e: any) => { enrMap[e._id] = e.count; });

    const enriched = users.map((u: any) => ({
      ...u,
      id: u._id?.toString(),
      enrollments: enrMap[u._id?.toString()] || 0,
    }));

    res.json({ success: true, users: enriched, total });
  } catch (err) {
    console.error('listAllUsers error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── PATCH /api/admin/users/:id ────────────────────────────────────────────────
export async function updateUser(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const { id } = req.params;
    const { role, isActive } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    // Prevent demoting self
    if (req.user?.id === id && role && role !== 'admin') {
      return res.status(400).json({ success: false, message: 'You cannot change your own admin role' });
    }

    const update: Record<string, any> = { updatedAt: new Date() };
    if (role !== undefined) update.role = role;
    if (isActive !== undefined) update.isActive = !!isActive;

    await db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: update });
    res.json({ success: true, message: 'User updated' });
  } catch (err) {
    console.error('updateUser error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
export async function deleteUser(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }
    if (req.user?.id === id) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    }

    await db.collection('users').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    console.error('deleteUser error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── GET /api/admin/courses ────────────────────────────────────────────────────
export async function listAllCourses(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const search = String(req.query.search || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const skip = Number(req.query.skip) || 0;

    const query: Record<string, any> = {};
    if (search) query.title = { $regex: search, $options: 'i' };

    const courses = await db
      .collection('courses')
      .find(query, { sort: { createdAt: -1 }, skip, limit })
      .toArray();
    const total = await db.collection('courses').countDocuments(query);

    const enriched = courses.map((c: any) => ({ ...c, id: c._id?.toString() }));
    res.json({ success: true, courses: enriched, total });
  } catch (err) {
    console.error('listAllCourses error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── DELETE /api/admin/courses/:id ─────────────────────────────────────────────
export async function deleteCourse(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }
    await Promise.all([
      db.collection('courses').deleteOne({ _id: new ObjectId(id) }),
      db.collection('enrollments').deleteMany({ courseId: id }),
    ]);
    res.json({ success: true, message: 'Course deleted' });
  } catch (err) {
    console.error('deleteCourse error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── PATCH /api/admin/courses/:id ──────────────────────────────────────────────
export async function updateCourseStatus(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const { id } = req.params;
    const { status } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }
    if (!['draft', 'published', 'archived'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    await db.collection('courses').updateOne({ _id: new ObjectId(id) }, { $set: { status, updatedAt: new Date() } });
    res.json({ success: true, message: 'Course status updated' });
  } catch (err) {
    console.error('updateCourseStatus error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── GET /api/admin/payments ───────────────────────────────────────────────────
export async function listAllPayments(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const skip = Number(req.query.skip) || 0;

    const orders = await db
      .collection('orders')
      .find({}, { sort: { createdAt: -1 }, skip, limit })
      .toArray();
    const total = await db.collection('orders').countDocuments();

    // Enrich with user + course names
    const userIds = [...new Set(orders.map((o: any) => o.userId).filter(Boolean))];
    const courseIds = [...new Set(orders.map((o: any) => o.courseId).filter(Boolean))];

    const [users, courses] = await Promise.all([
      userIds.length
        ? db.collection('users').find({ _id: { $in: userIds.filter(ObjectId.isValid).map((id) => new ObjectId(id as string)) } }, { projection: { name: 1, email: 1 } }).toArray()
        : [],
      courseIds.length
        ? db.collection('courses').find({ _id: { $in: courseIds.filter(ObjectId.isValid).map((id) => new ObjectId(id as string)) } }, { projection: { title: 1 } }).toArray()
        : [],
    ]);

    const userMap: Record<string, any> = {};
    users.forEach((u: any) => { userMap[u._id.toString()] = u; });
    const courseMap: Record<string, any> = {};
    courses.forEach((c: any) => { courseMap[c._id.toString()] = c; });

    const enriched = orders.map((o: any) => ({
      ...o,
      id: o._id?.toString(),
      userName: userMap[o.userId]?.name || o.userId,
      userEmail: userMap[o.userId]?.email || '',
      courseTitle: courseMap[o.courseId]?.title || o.courseId,
    }));

    res.json({ success: true, orders: enriched, total });
  } catch (err) {
    console.error('listAllPayments error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── GET /api/admin/certificates ───────────────────────────────────────────────
export async function listAllCertificates(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const skip = Number(req.query.skip) || 0;

    const certs = await db
      .collection('certificates')
      .find({}, { sort: { issuedDate: -1 }, skip, limit })
      .toArray();
    const total = await db.collection('certificates').countDocuments();

    const userIds = [...new Set(certs.map((c: any) => c.student).filter(Boolean))];
    const courseIds = [...new Set(certs.map((c: any) => c.course).filter(Boolean))];

    const [users, courses] = await Promise.all([
      userIds.length
        ? db.collection('users').find({ _id: { $in: userIds.filter(ObjectId.isValid).map((id) => new ObjectId(id as string)) } }, { projection: { name: 1, email: 1 } }).toArray()
        : [],
      courseIds.length
        ? db.collection('courses').find({ _id: { $in: courseIds.filter(ObjectId.isValid).map((id) => new ObjectId(id as string)) } }, { projection: { title: 1 } }).toArray()
        : [],
    ]);

    const userMap: Record<string, any> = {};
    users.forEach((u: any) => { userMap[u._id.toString()] = u; });
    const courseMap: Record<string, any> = {};
    courses.forEach((c: any) => { courseMap[c._id.toString()] = c; });

    const enriched = certs.map((c: any) => ({
      ...c,
      id: c._id?.toString(),
      studentName: userMap[c.student]?.name || c.student,
      studentEmail: userMap[c.student]?.email || '',
      courseTitle: courseMap[c.course]?.title || c.course,
    }));

    res.json({ success: true, certificates: enriched, total });
  } catch (err) {
    console.error('listAllCertificates error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ── GET /api/admin/activity ───────────────────────────────────────────────────
export async function getRecentActivity(req: AuthRequest, res: Response) {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDB();
    const [recentUsers, recentCourses, recentEnrollments] = await Promise.all([
      db.collection('users').find({}, { sort: { createdAt: -1 }, limit: 5, projection: { password: 0 } }).toArray(),
      db.collection('courses').find({}, { sort: { createdAt: -1 }, limit: 5, projection: { title: 1, status: 1, instructorName: 1, enrollmentCount: 1 } }).toArray(),
      db.collection('enrollments').find({}, { sort: { enrolledAt: -1 }, limit: 5 }).toArray(),
    ]);

    res.json({
      success: true,
      recentUsers: recentUsers.map((u: any) => ({ ...u, id: u._id?.toString() })),
      recentCourses: recentCourses.map((c: any) => ({ ...c, id: c._id?.toString() })),
      recentEnrollments,
    });
  } catch (err) {
    console.error('getRecentActivity error', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}
