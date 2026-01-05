const express = require('express');
const mysql = require('mysql2/promise'); // Promise-based
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); 
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- FILE UPLOAD SETUP ---
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, 'file-' + Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// --- DB CONNECTION ---
const db = mysql.createPool({
    host: 'localhost', user: 'root', password: '', database: 'civiltech_db',
    waitForConnections: true, connectionLimit: 10, queueLimit: 0
});

// Test Connection
(async () => {
    try {
        const conn = await db.getConnection();
        console.log('✅ MySQL Connected');
        conn.release();
    } catch (err) { console.error('❌ DB Failed:', err.message); }
})();

// ==========================================
// 1. PROJECTS (Updated with ALL 30+ Fields)
// ==========================================
app.get('/api/projects-full', async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT p.*, c.company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id ORDER BY p.id DESC`);
        res.json(rows);
    } catch (err) { res.status(500).json(err); }
});

// --- HELPER: Convert Empty Strings to NULL ---
const toNull = (val) => (val === '' || val === 'undefined' || val === 'null' ? null : val);

// --- UPDATE: POST PROJECT (Robust Error Handling) ---
app.post('/api/projects', async (req, res) => {
    try {
        const { 
            project_name, company_id, location, start_date, end_date, status, coordinates,
            project_type, description, country, city, area, block, street,
            estimated_cost, approved_budget, actual_cost, supervisor_name, engineer_name
        } = req.body;

        // Parse Coordinates
        let lat = null, long = null;
        if(coordinates && coordinates.includes(',')) {
            [lat, long] = coordinates.split(',').map(s => s.trim());
        }

        const sql = `
            INSERT INTO projects (
                project_name, company_id, location_address, location_coordinates, 
                start_date, end_date, status,
                project_type, description, country, city, area, block, street, gps_lat, gps_long,
                estimated_cost, approved_budget, actual_cost, supervisor_name, engineer_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const values = [
            project_name, 
            toNull(company_id), 
            location, 
            coordinates, 
            toNull(start_date), 
            toNull(end_date), 
            status || 'Planned',
            project_type, 
            description, 
            country, 
            city, 
            area, 
            block, 
            street, 
            lat, 
            long,
            toNull(estimated_cost), 
            toNull(approved_budget), 
            toNull(actual_cost), 
            supervisor_name, 
            engineer_name
        ];

        const [result] = await db.query(sql, values);
        res.json({ message: "Project created", id: result.insertId });
    } catch (err) { 
        console.error("❌ DB Insert Error:", err.sqlMessage || err.message);
        res.status(500).json({ error: "Database Error: " + (err.sqlMessage || err.message) }); 
    }
});
app.get('/api/projects/:id', async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT p.*, c.company_name FROM projects p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?`, [req.params.id]);
        if(rows.length === 0) return res.status(404).json({message: "Not found"});
        res.json(rows[0]);
    } catch (err) { res.status(500).json(err); }
});

// --- PROJECT SUB-DATA ---
app.get('/api/projects/:id/scope', async (req, res) => {
    try {
        const sql = `SELECT c.category_name, c.unit_of_measurement, ps.planned_quantity, COALESCE(SUM(dp.quantity_completed), 0) as actual_quantity
            FROM project_scope ps JOIN categories c ON ps.category_id = c.id
            LEFT JOIN daily_progress dp ON dp.project_id = ps.project_id AND dp.category_id = ps.category_id
            WHERE ps.project_id = ? GROUP BY ps.category_id`;
        const [rows] = await db.query(sql, [req.params.id]);
        res.json(rows);
    } catch (err) { res.status(500).json(err); }
});

app.get('/api/projects/:id/photos', async (req, res) => {
    try {
        const sql = `SELECT pp.photo_url, pp.upload_timestamp, c.category_name FROM progress_photos pp
            JOIN daily_progress dp ON pp.daily_progress_id = dp.id JOIN categories c ON dp.category_id = c.id
            WHERE dp.project_id = ? ORDER BY pp.upload_timestamp DESC`;
        const [rows] = await db.query(sql, [req.params.id]);
        res.json(rows);
    } catch (err) { res.status(500).json(err); }
});

app.get('/api/projects/:id/labor', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM daily_labor WHERE project_id = ? ORDER BY report_date DESC", [req.params.id]);
        res.json(rows);
    } catch (err) { res.status(500).json(err); }
});

app.get('/api/projects/:id/equipment', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM equipment_log WHERE project_id = ? ORDER BY log_date DESC", [req.params.id]);
        res.json(rows);
    } catch (err) { res.status(500).json(err); }
});

// --- GIS & DOCUMENTS (NEW) ---
app.get('/api/projects/:id/gis', async (req, res) => {
    try {
        // Return empty array if table doesn't exist yet to prevent crash
        try {
            const [rows] = await db.query("SELECT * FROM project_gis WHERE project_id = ?", [req.params.id]);
            res.json(rows);
        } catch (e) { res.json([]); }
    } catch (err) { res.status(500).json(err); }
});

app.get('/api/projects/:id/documents', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM project_documents WHERE project_id = ? ORDER BY uploaded_at DESC", [req.params.id]);
        res.json(rows);
    } catch (err) { 
        console.error("Doc Error:", err.message);
        res.json([]); // Return empty if table missing, don't crash
    }
});

app.post('/api/documents', upload.single('file'), async (req, res) => {
    try {
        const { project_id, doc_type, title, uploaded_by } = req.body;
        const file_url = req.file ? req.file.filename : null;
        await db.query("INSERT INTO project_documents (project_id, doc_type, title, file_url, uploaded_by) VALUES (?, ?, ?, ?, ?)", 
            [project_id, doc_type, title, file_url, uploaded_by]);
        res.json({ message: "Uploaded" });
    } catch (err) { res.status(500).json(err); }
});

// ==========================================
// 2. AUTH, DASHBOARD & RESOURCES (Standard)
// ==========================================
app.post('/api/register', upload.single('profile_image'), async (req, res) => {
    try {
        const { full_name, email, password, role, status } = req.body;
        const profile_image = req.file ? req.file.filename : null;
        const [existing] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
        if (existing.length > 0) return res.status(400).json({ message: "Email exists" });
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        const [result] = await db.query("INSERT INTO users (full_name, email, password, role, status, profile_image) VALUES (?, ?, ?, ?, ?, ?)", [full_name, email, hash, role, status || 'Active', profile_image]);
        res.json({ message: "User registered", id: result.insertId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
        if (users.length === 0) return res.status(400).json({ message: "User not found" });
        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });
        res.json({ id: user.id, name: user.full_name, email: user.email, role: user.role, profile_image: user.profile_image });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users', async (req, res) => {
    const [rows] = await db.query("SELECT id, full_name, email, role, status, profile_image FROM users");
    res.json(rows);
});

// --- DASHBOARD ---
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [total] = await db.query("SELECT COUNT(*) AS count FROM projects");
        const [completed] = await db.query("SELECT COUNT(*) AS count FROM projects WHERE status='Completed'");
        const [ongoing] = await db.query("SELECT COUNT(*) AS count FROM projects WHERE status='Ongoing'");
        const [companies] = await db.query("SELECT COUNT(*) AS count FROM companies");
        const [labor] = await db.query("SELECT SUM(labor_count) AS count FROM daily_labor WHERE report_date = CURDATE()");
        const [civil] = await db.query("SELECT SUM(quantity_completed) AS count FROM daily_progress WHERE category_id = 1");
        res.json({ total: total[0].count, completed: completed[0].count, ongoing: ongoing[0].count, companies: companies[0].count, labor: labor[0]?.count || 0, civil: civil[0]?.count || 0 });
    } catch (err) { res.status(500).json(err); }
});

app.get('/api/charts/company-status', async (req, res) => {
    const [rows] = await db.query(`SELECT c.company_name as name, SUM(CASE WHEN p.status='Completed' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN p.status='Ongoing' THEN 1 ELSE 0 END) as ongoing FROM projects p JOIN companies c ON p.company_id = c.id GROUP BY c.company_name`);
    res.json(rows);
});

app.get('/api/charts/work-distribution', async (req, res) => {
    const [rows] = await db.query(`SELECT c.category_name as name, SUM(dp.quantity_completed) as value FROM daily_progress dp JOIN categories c ON dp.category_id = c.id GROUP BY c.category_name`);
    const colors = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#64748b'];
    res.json(rows.map((item, i) => ({ name: item.name, value: parseFloat(item.value)||0, color: colors[i % colors.length] })));
});

// --- COMPANIES & PAYMENTS ---
app.get('/api/companies', async (req, res) => {
    const [rows] = await db.query(`SELECT c.*, COUNT(p.id) as project_count FROM companies c LEFT JOIN projects p ON c.id = p.company_id GROUP BY c.id ORDER BY c.id DESC`);
    res.json(rows);
});
app.post('/api/companies', async (req, res) => {
    const { company_name, type, phone, email, status } = req.body;
    await db.query("INSERT INTO companies (company_name, type, phone, email, status) VALUES (?, ?, ?, ?, ?)", [company_name, type, phone, email, status || 'Active']);
    res.json({ message: "Company added" });
});
app.get('/api/companies/:id', async (req, res) => {
    const [rows] = await db.query("SELECT * FROM companies WHERE id = ?", [req.params.id]);
    res.json(rows[0]);
});
app.get('/api/companies/:id/projects', async (req, res) => {
    const [rows] = await db.query("SELECT * FROM projects WHERE company_id = ?", [req.params.id]);
    res.json(rows);
});
app.get('/api/companies/:id/payments', async (req, res) => {
    const [rows] = await db.query("SELECT * FROM company_payments WHERE company_id = ? ORDER BY payment_date DESC", [req.params.id]);
    res.json(rows);
});
app.post('/api/payments', async (req, res) => {
    const { company_id, amount, payment_type, description, payment_date } = req.body;
    await db.query("INSERT INTO company_payments (company_id, amount, payment_type, description, payment_date) VALUES (?, ?, ?, ?, ?)", [company_id, amount, payment_type, description, payment_date]);
    res.json({ message: "Recorded" });
});
app.put('/api/payments/:id', async (req, res) => {
    const { amount, payment_type, description, payment_date } = req.body;
    await db.query("UPDATE company_payments SET amount=?, payment_type=?, description=?, payment_date=? WHERE id=?", [amount, payment_type, description, payment_date, req.params.id]);
    res.json({ message: "Updated" });
});
app.delete('/api/payments/:id', async (req, res) => {
    await db.query("DELETE FROM company_payments WHERE id=?", [req.params.id]);
    res.json({ message: "Deleted" });
});

// --- MESSAGES ---
app.get('/api/messages/:userId', async (req, res) => {
    const [rows] = await db.query(`SELECT m.*, u.full_name as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.receiver_id = ? ORDER BY m.created_at DESC`, [req.params.userId]);
    res.json(rows);
});
app.get('/api/messages/sent/:userId', async (req, res) => {
    const [rows] = await db.query(`SELECT m.*, u.full_name as receiver_name FROM messages m JOIN users u ON m.receiver_id = u.id WHERE m.sender_id = ? ORDER BY m.created_at DESC`, [req.params.userId]);
    res.json(rows);
});
app.post('/api/messages', async (req, res) => {
    const { sender_id, receiver_id, subject, message_body } = req.body;
    await db.query("INSERT INTO messages (sender_id, receiver_id, subject, message_body) VALUES (?, ?, ?, ?)", [sender_id, receiver_id, subject, message_body]);
    await db.query("INSERT INTO notifications (message, type) VALUES (?, 'Info')", [`New Message: ${subject}`]);
    res.json({ message: "Sent" });
});
app.get('/api/notifications', async (req, res) => {
    const [rows] = await db.query("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 10");
    res.json(rows);
});
app.delete('/api/notifications', async (req, res) => {
    await db.query("DELETE FROM notifications");
    res.json({ message: "Cleared" });
});

// --- RESOURCES (Fleet, Labor, CMS) ---
app.get('/api/search', async (req, res) => {
    const q = req.query.q;
    const [rows] = await db.query(`SELECT id, project_name as title, 'Project' as type FROM projects WHERE project_name LIKE ? UNION SELECT id, company_name as title, 'Company' as type FROM companies WHERE company_name LIKE ?`, [`%${q}%`, `%${q}%`]);
    res.json(rows);
});
app.get('/api/categories', async (req, res) => { const [rows] = await db.query("SELECT * FROM categories"); res.json(rows); });
app.post('/api/categories', async (req, res) => { await db.query("INSERT INTO categories (category_name, unit_of_measurement) VALUES (?, ?)", [req.body.category_name, req.body.unit_of_measurement]); res.json({message:"Added"}); });
app.get('/api/fleet', async (req, res) => { const [rows] = await db.query("SELECT * FROM fleet ORDER BY id DESC"); res.json(rows); });
app.post('/api/fleet', async (req, res) => { await db.query("INSERT INTO fleet (vehicle_name, plate_number, type) VALUES (?, ?, ?)", [req.body.vehicle_name, req.body.plate_number, req.body.type]); res.json({message:"Added"}); });
app.get('/api/labor-roles', async (req, res) => { const [rows] = await db.query("SELECT * FROM labor_roles"); res.json(rows); });
app.post('/api/labor-roles', async (req, res) => { await db.query("INSERT INTO labor_roles (role_name) VALUES (?)", [req.body.role_name]); res.json({message:"Added"}); });
app.get('/api/labor', async (req, res) => { const [rows] = await db.query("SELECT l.*, p.project_name FROM daily_labor l LEFT JOIN projects p ON l.project_id = p.id ORDER BY l.report_date DESC"); res.json(rows); });
app.post('/api/labor', async (req, res) => {
    const { project_id, report_date, engineer_count, technician_count, labor_count, total_hours } = req.body;
    await db.query("INSERT INTO daily_labor (project_id, report_date, engineer_count, technician_count, labor_count, total_hours) VALUES (?, ?, ?, ?, ?, ?)", [project_id, report_date, engineer_count, technician_count, labor_count, total_hours]);
    res.json({ message: "Added" });
});
app.get('/api/equipment', async (req, res) => { const [rows] = await db.query("SELECT e.*, p.project_name FROM equipment_log e LEFT JOIN projects p ON e.project_id = p.id ORDER BY e.log_date DESC"); res.json(rows); });
app.post('/api/equipment', async (req, res) => {
    const { project_id, equipment_name, status, hours_operated, log_date } = req.body;
    await db.query("INSERT INTO equipment_log (project_id, equipment_name, status, hours_operated, log_date) VALUES (?, ?, ?, ?, ?)", [project_id, equipment_name, status, hours_operated, log_date]);
    res.json({ message: "Added" });
});

// START SERVER
app.listen(5000, () => {
    console.log("🚀 Server running on port 5000");
});