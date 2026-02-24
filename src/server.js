// server.js

// 1. IMPORTS
import express from "express";
import bcrypt from "bcrypt";
import { pool } from "./db.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import multer from "multer";
import path from "path";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import crypto from "crypto";
import { createGroqMessages } from "./tfb-support.js";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { CryptoMiner } from "./CryptoMiner.js";
import { body, validationResult } from "express-validator";
import sgMail from "@sendgrid/mail"; // ✅ NEW

// 2. CONFIG & ENVIRONMENT
dotenv.config({ quiet: true });
const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT;
const JWT_SECRET = process.env.JWT_SECRET;

// 3. MIDDLEWARE
app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = [
        "https://www.trusted-finance.biz",
        "https://api.trusted-finance.biz",
        "https://trusted-finance.biz",
        undefined,
        null,
      ];
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(helmet());

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many login attempts. Try again later.",
});

const minerLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
});

app.use(express.json());
app.use(cookieParser());

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} from ${req.ip}`
  );
  next();
});

global.miners = global.miners || {};

// Mongo sanitize
function mongoSanitizeCustom(req, res, next) {
  const sanitize = (obj) => {
    if (typeof obj !== "object" || obj === null) return obj;
    const sanitized = { ...obj };
    for (const key in sanitized) {
      if (key.startsWith("$") || key.includes(".")) {
        delete sanitized[key];
      } else {
        sanitized[key] = sanitize(sanitized[key]);
      }
    }
    return sanitized;
  };

  req.body = sanitize(req.body);
  req.params = sanitize(req.params);
  next();
}

app.use(mongoSanitizeCustom);

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// =======================================================
// ✅ UPDATED EMAIL TRANSPORTER (SendGrid API instead of SMTP)
// =======================================================

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const transporter = {
  sendMail: async ({ from, to, subject, html }) => {
    return sgMail.send({
      to,
      from,
      subject,
      html,
    });
  },
};

// =======================================================

// MULTER SETUP
const storage = multer.diskStorage({
  destination: "./uploads/profile-pics/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    if (extname) return cb(null, true);
    cb(new Error("Error: Images only!"));
  },
}).single("profilePic");

// ============================
// SIGNUP
// ============================
app.post(
  "/signup",
  [
    body("email").isEmail().normalizeEmail(),
    body("username").isLength({ min: 3, max: 20 }).trim().escape(),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 chars"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const {
        fullname,
        username,
        email,
        password,
        bitcoinWallet,
        ethWallet,
        usdtTRC20Wallet,
        tronWallet,
        bnbWallet,
        Referrer,
      } = req.body;

      const passwordHash = await bcrypt.hash(password, 10);

      const result = await pool.query(
        `INSERT INTO users (
        full_name, username, email, password_hash,
        bitcoin_address, ethereum_address, usdt_trc20_address,
        tron_address, bnb_address, referrer
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id, username, email, full_name`,
        [
          fullname,
          username.toLowerCase(),
          email.toLowerCase(),
          passwordHash,
          bitcoinWallet || null,
          ethWallet || null,
          usdtTRC20Wallet || null,
          tronWallet || null,
          bnbWallet || null,
          Referrer || null,
        ]
      );

      authLimiter.resetKey(req.ip);

      const newUser = result.rows[0];

      const token = jwt.sign(
        {
          id: newUser.id,
          full_name: newUser.full_name,
          username: newUser.username,
          email: newUser.email,
        },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      res.cookie("auth_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/",
        domain: ".trusted-finance.biz",
      });

      res.status(201).json({
        message: "User registered successfully!",
        user: newUser,
      });

      await transporter.sendMail({
        from: `"TrustedFinance Support" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Welcome to TrustedFinance.biz!",
        html: `<p>Welcome ${newUser.full_name}</p>`,
      });
    } catch (err) {
      console.error("Signup error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// ============================
// LOGIN
// ============================
app.post("/login", authLimiter, async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username.toLowerCase()]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    authLimiter.resetKey(req.ip);

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        email: user.email,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    res.json({
      message: "Logged in successfully",
      user: { id: user.id, username: user.username },
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ============================
// AUTH MIDDLEWARE
// ============================
const authenticate = (req, res, next) => {
  const token = req.cookies.auth_token;

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

// ============================
// ACCOUNT
// ============================
app.get("/account", authenticate, (req, res) => {
  res.json({
    message: "Welcome to your account!",
    user: req.user,
  });
});

// ============================
// START SERVER
// ============================
app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
