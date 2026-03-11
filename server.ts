import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database("greenledger.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT,
    report_year TEXT,
    overall_score INTEGER,
    grade TEXT,
    env_score INTEGER,
    soc_score INTEGER,
    gov_score INTEGER,
    red_flags TEXT,
    blockchain_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/reports", (req, res) => {
    const reports = db.prepare("SELECT * FROM reports ORDER BY created_at DESC").all();
    res.json(reports);
  });

  app.post("/api/reports", (req, res) => {
    const { 
      company_name, report_year, overall_score, grade, 
      env_score, soc_score, gov_score, red_flags, blockchain_hash 
    } = req.body;

    const stmt = db.prepare(`
      INSERT INTO reports (
        company_name, report_year, overall_score, grade, 
        env_score, soc_score, gov_score, red_flags, blockchain_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      company_name, report_year, overall_score, grade, 
      env_score, soc_score, gov_score, JSON.stringify(red_flags), blockchain_hash
    );

    res.json({ id: result.lastInsertRowid });
  });

  app.delete("/api/reports/:id", (req, res) => {
    const { id } = req.params;
    db.prepare("DELETE FROM reports WHERE id = ?").run(id);
    res.json({ success: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
