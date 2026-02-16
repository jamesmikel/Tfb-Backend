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
import nodemailer from "nodemailer";
import crypto from "crypto";
import { createGroqMessages } from "./tfb-support.js";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { CryptoMiner } from "./CryptoMiner.js";
import { body, validationResult } from "express-validator"; // for input validation




// 2. CONFIG & ENVIRONMENT
dotenv.config({quiet: true});
const app = express();
app.set('trust proxy', 1); // trust first proxy
const port = process.env.PORT 
const JWT_SECRET = process.env.JWT_SECRET;





// 3. MIDDLEWARE
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      
      "www.trusted-finance.biz",
      
      "https://tfb-backend-mv66.onrender.com",
      "https://trusted-finance.biz", // add your production frontend
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
}));

// Trust proxy for secure cookies behind proxies (e.g., Heroku, Vercel)




app.use(helmet()); // Adds CSP, X-XSS-Protection, etc.

// Global rate limiter (adjust limits)


// Specific routes limiter (e.g., login/signup)
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 attempts per hour per IP
  message: "Too many login attempts. Try again later.",
});
const minerLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
});


app.use(express.json());
app.use(cookieParser());


global.miners = global.miners || {}

function mongoSanitizeCustom(req, res, next) {
  const sanitize = (obj) => {
    if (typeof obj !== 'object' || obj === null) return obj;
    const sanitized = { ...obj };
    for (const key in sanitized) {
      if (key.startsWith('$') || key.includes('.')) {
        delete sanitized[key];  // Or replace: sanitized[key.replace(/\$/g, '_')] = sanitized[key]; delete sanitized[key];
      } else {
        sanitized[key] = sanitize(sanitized[key]);
      }
    }
    return sanitized;
  };

  req.body = sanitize(req.body);
  req.params = sanitize(req.params);
  // For req.query, since it's a getter, we can't reassign — access via req._parsedUrl.query or parse manually if needed
  // But for safety, you can skip or clone: const safeQuery = sanitize(req.query); req.query = new Proxy(safeQuery, {}); // Advanced
  next();

}



app.use(mongoSanitizeCustom);
// Serve static files (uploads folder)
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")))


// 4. EMAIL TRANSPORTER
const transporter = nodemailer.createTransport({
  host: "smtpout.secureserver.net",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify((error, success) => {
  if (error) {
    console.error("Email transporter error:", error);
  } else {
    console.log("Email transporter ready");
  }
});

// 4. MULTER SETUP (file upload handling)
const storage = multer.diskStorage({
  destination: "./uploads/profile-pics/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (extname) return cb(null, true);
    cb(new Error("Error: Images only!"));
  },
}).single("profilePic");

// ROUTES

// Signup
app.post("/signup", [
    body("email").isEmail().normalizeEmail(),
    body("username").isLength({ min: 3, max: 20 }).trim().escape(),
    body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 chars"),
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        Referrer || null
      ]
    );
    // ✅ SUCCESS → RESET RATE LIMIT
    authLimiter.resetKey(req.ip);

    const newUser = result.rows[0];

     const token = jwt.sign(
      { id: newUser.id, full_name: newUser.full_name, username: newUser.username, email: newUser.email },
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


    res.status(201).json({
      message: "User registered successfully!",
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        full_name: newUser.full_name,
      },
    });
    // Send welcome email

    await transporter.sendMail({
      from: `"TrustedFinance Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Welcome to TrustedFinance.biz!',
      html: `
        <p>Dear ${newUser.full_name || 'User'},</p>
        <p>Thank you for joining TrustedFinance.biz!</p>
        <p>Your account has been successfully created with the email: ${newUser.email}.</p>
        <p>You can now log in and start exploring our platform:</p>
        <a href="https://trusted-finance.biz/login" style="padding: 10px 20px; background: #07091a; color: white; text-decoration: none; border-radius: 8px;">
          Login to TrustedFinance
        </a>
        <p>Quick tips to get started:
• Complete your profile and enable your profile picture for to connect with our vast trading community
• Join our referral program and earn rewards by inviting friends</p>
        <p>If you have any questions, our support team is here 24/7.

Happy trading!

Best regards,  
TrustedFinance.biz 
admin@trusted-finance.biz  </p>
        <small>https://trusted-finance.biz</small>
      `,
    });
    
  } catch (err) {
    console.error("Signup error:", err);
    if (err.code === "23505") {
      let message = "Username or email already exists";
      if (err.detail?.includes("username")) message = "This username is already taken";
      if (err.detail?.includes("email")) message = "This email is already registered";
      return res.status(409).json({ error: message });
    }
    res.status(500).json({ error: "Server error" });
  }
});


// Referral lookup
app.post("/referral", async (req, res) => {
  const { ref } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [ref.toLowerCase()]
    );
    const user = result.rows[0];
    res.json({ user: { id: user.id, username: user.username, full_name: user.full_name } });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});


//Support

  // In your /support route
app.post("/support", async (req, res) => {
  const { name, email, message } = req.body;

  try {
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant", // or "llama-3.1-8b-instant" for speed
        messages: createGroqMessages(name, message),
        temperature: 0.6,
        max_tokens: 600,
        top_p: 0.9
      })
    });

    if (!groqResponse.ok) {
      throw new Error(`Groq error: ${groqResponse.status}`);
    }

    const data = await groqResponse.json();
    const reply = data.choices[0].message.content.trim();

    // Optional: Send email
    await transporter.sendMail({
      from: `"TrustedFinance Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "TrustedFinance Support - Your Message",
      html: reply,
    });

    res.status(200).json({
      message: "Support message processed successfully!",
      reply // optional - return to frontend
    });
  } catch (err) {
    console.error("Support error:", err);
    res.status(500).json({ error: "Failed to process message" });
  }
});


// Login
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
    // ✅ SUCCESS → RESET RATE LIMIT
      authLimiter.resetKey(req.ip);
      const referrals = await pool.query("SELECT * FROM users WHERE referrer =$1", [user.username])
      
    
   const refCount = referrals.rows.length;
   

    const token = jwt.sign(
      { id: user.id, full_name: user.full_name, username: user.username, email: user.email, profile_pic: user.profile_pic, referrer: user.referrer,referrals: refCount, created_at: user.created_at,address:{bitcoin: user.bitcoin_address, ethereum: user.ethereum_address, usdt_trc20: user.usdt_trc20_address, tron: user.tron_address, bnb: user.bnb_address } },
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

// Logout
app.post("/logout", (req, res) => {
  res.clearCookie("auth_token", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
  });

  res.json({ message: "Logged out" });


});

// Authentication middleware

const authenticate = (req, res, next) => {
  const token = req.cookies.auth_token;

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

app.post("/edit-account", authenticate, async (req, res) => {
  const { 
      fullname,
      username,
      email,
      password,
      bitcoinWallet,
      ethWallet,
      usdtTRC20Wallet,
      tronWallet,
      bnbWallet } = req.body;
      const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  try {
    await pool.query(
      `UPDATE users SET 
        full_name = $1,
        username = $2,
        email = $3,
        ${passwordHash ? "password_hash = $4," : ""}
        bitcoin_address = $5,
        ethereum_address = $6,
        usdt_trc20_address = $7,
        tron_address = $8,
        bnb_address = $9
      WHERE id = $10`,
      [
        fullname || null,
        username.toLowerCase() || null,
        email.toLowerCase() || null,
        passwordHash || null,
        bitcoinWallet || null,
        ethWallet || null,
        usdtTRC20Wallet || null,
        tronWallet || null,
        bnbWallet || null,
        req.user.id
      ]
    );
    res.json({ message: "Account updated successfully" });
  } catch (err) {
    console.error("Edit account error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Forgot Password – Send Reset Link

app.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
``
  try {
    // Find user by email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];

    // Don't reveal if email exists (security best practice)
    if (!user) {
      return res.status(200).json({ message: "If the email exists, a reset link has been sent." });
    }

    // Generate secure token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = await bcrypt.hash(resetToken, 10);
    const resetExpires = Date.now() + 60 * 60 * 1000; // 1 hour

    // Save token and expiry to DB
    await pool.query(
      'UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3',
      [hashedToken, resetExpires, user.id]
    );

    // Send email
    const resetUrl = `https://trusted-finance.biz/reset-password?token=${resetToken}`;

    await transporter.sendMail({
      from: `"TrustedFinance Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Reset Your TrustedFinance.biz Password',
      html: `
        <p>Dear ${user.full_name || 'User'},</p>
        <p>We received a request to reset your password.</p>
        <p>Click the link below to reset it (expires in 60 minutes):</p>
        <a href="${resetUrl}" style="padding: 10px 20px; background: #02030b; color: white; text-decoration: none; border-radius: 8px;">
          Reset Password
        </a>
        <p>If you didn't request this, ignore this email — your account is safe.</p>
        <p>For security: Never share this link.</p>
        <p>Best regards,<br>TrustedFinance Support Team</p>
        <small>https://trusted-finance.biz</small>
      `,
    });
    // ✅ SUCCESS → RESET RATE LIMIT
      authLimiter.resetKey(req.ip);

    res.status(200).json({ message: "If the email exists, a reset link has been sent." });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 2. Reset Password – Validate Token & Update Password
app.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Invalid request or password too short' });
  }

  
  try {
    // Find user with valid token
    const result = await pool.query(
      'SELECT * FROM users WHERE reset_expires > $1',
      [ Date.now()]
    );

    const user = result.rows[0];
   if (!token || !(await bcrypt.compare(token, user.reset_token))) {
      return res.status(401).json({ error: "Invalid or expired reset token" });
    }
    if (!user) {
      return res.status(400).json({ error: 'Invalid User.' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset token
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2',
      [hashedPassword, user.id]
    );

    res.status(200).json({ message: 'Password reset successful. Please log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload profile picture (protected)
app.post("/api/upload-profile-pic", authenticate,  (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    
    const fileName = req.file.filename;

    const imageUrl = `${req.protocol}://${req.get("host")}/uploads/profile-pics/${fileName}`
    await pool.query("UPDATE users SET profile_pic = $1 WHERE id = $2", [imageUrl, req.user.id]);

    res.json({ success: true, imageUrl });
  });``
});

app.post("/deposit", authenticate, async (req, res) => {
  const {
    DepositAmount,
    ProposedPercent,
    ProposedTime,
    } = req.body;
  try {
    await pool.query(
      "INSERT INTO user_deposits (id, user_id, deposit_amount, proposedpercent, proposedtime) VALUES ($1, $2, $3, $4, $5)",
      [req.user.id, req.user.username, DepositAmount, ProposedPercent, ProposedTime]
    );await pool.query(
  `INSERT INTO transactions 
   (user_id, type, amount, description, reference, metadata) 
   VALUES ($1, 'mining_plan', $2, $3, $4, $5)`,
  [
    req.user.id,
    DepositAmount,
    `${ProposedPercent * 100}% After ${ProposedTime/3600000} hours`,
    `dep_${Math.floor(Math.random() * 100000)}`,
    JSON.stringify({
      plan: `${ProposedPercent * 100}% After ${ProposedTime/3600000} hours`,
      proposedPercent: ProposedPercent,
      proposedTime: ProposedTime
    })
  ]
);
    res.json({ success: true, message: "Deposit submitted successfully." });
    await transporter.sendMail({
      from: `"TrustedFinance" <${process.env.EMAIL_USER}>`,
      to: req.user.email,
      subject: 'Your Deposit is Being Processed',
      html: `
        <p>Dear ${req.user.full_name || 'User'},</p>
        <p>We received a request to process a deposit for your account.</p>
        <p>Your deposit of $${DepositAmount} is being processed with the following details:</p>
        <ul>
          <li>Proposed Interest Rate: ${ProposedPercent *100}%</li>
          <li>Proposed Time Period: ${ProposedTime/3600000} hours</li>
        </ul>
        <p>Please allow up to 24 hours for processing.</p>
        <p>If you have any questions, contact our support team.</p>
         
        <p>Best regards,<br>TrustedFinance Support Team</p>
        <small>https://trusted-finance.biz</small>
      `,
    });
  } catch (err) {
    if (err.code === "23505") {
      let message = "A deposit is currently being processed for this user.";
      return res.status(409).json({ error: message });
    }
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Failed to submit deposit." });
  }
});

// Confirm deposit 
app.get("/confirm-deposit", authenticate, async (req, res) => {
  
  try {
    const user = await pool.query(
      "SELECT confirmed_deposit FROM user_deposits WHERE user_id = $1",
      [req.user.username]
    );
    if (user.rows[0]===undefined) {
      return res.status(404).json({ error: "No deposit found for this user." });
    }
    else{
      
      const plan = await pool.query(
        "SELECT * FROM user_deposits WHERE user_id = $1",
        [req.user.username]
      );
      if (plan.rows[0].confirmed_deposit !== plan.rows[0].deposit_amount) {
          await transporter.sendMail({
          from: `"TrustedFinance" <${process.env.EMAIL_USER}>`,
          to: req.user.email,
          subject: 'Deposit Confirmation Failed',
          html: `
            <p>Dear ${req.user.full_name || 'User'},</p>
            <p>We regret to inform you that there was an issue confirming your deposit of $${plan.rows[0].deposit_amount}.</p>
            <p>Please ensure that the deposit amount is correct and try again. If the issue persists, contact our support team for assistance.</p>
            <p>Best regards,<br>TrustedFinance Support Team</p>
            <small>https://trusted-finance.biz</small>
          `,
        });
        return res.status(400).json({ error: "Deposit confirmation failed. Please try again." });
      }
      await pool.query(
        "INSERT INTO transactions (user_id, type, amount, description, reference) VALUES ($1, 'deposit', $2, 'Bitcoin deposit confirmed', $3)",
        [req.user.id, plan.rows[0].confirmed_deposit, `dep_${Math.floor(Math.random() * 100000)}`]
      );

      const referralBonus = [ 0.08, 0.05, 0.02 ]; 
      try {
        let currentReferrer = req.user.referrer;   // Start with direct referrer
        const userResult = await pool.query(
  "SELECT referral_level FROM user_deposits WHERE user_id = $1",
  [currentReferrer]
);
 const userReferralLevel = userResult.rows[0]?.referral_level || 0;
let level = userReferralLevel; // Start from the user's current referral level
       

    // Walk up the referral chain and award bonuses
    while (currentReferrer && level < referralBonus.length) {
      const refResult = await pool.query("SELECT * FROM users WHERE username = $1", [currentReferrer]);
      if (refResult.rows.length === 0) break;

      const refUser = refResult.rows[0];
      const bonusRate = referralBonus[level];
      const bonusAmount = plan.rows[0].confirmed_deposit * bonusRate;
      await pool.query(
        "INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, 'referral_bonus', $2, 'Level 1 referral bonus', $3)",
        [refUser.id, bonusAmount, JSON.stringify({ level: level + 1, from_user: req.user.username, from_deposit: plan.rows[0].confirmed_deposit })]
      );
      await transporter.sendMail({
        from: `"TrustedFinance" <${process.env.EMAIL_USER}>`,
        to: refUser.email,
        subject: 'Referral Bonus Received',
        html: `
          <p>Dear ${currentReferrer || 'User'},</p>
          <p>You have received a referral bonus of $${bonusAmount.toFixed(2)} for referring a new user.</p>
          <p> Level ${level + 1} </p>

          <p>Best regards,<br>TrustedFinance Support Team</p>
          <small>https://trusted-finance.biz</small>
        `,
      });
      await pool.query(
    "UPDATE user_deposits SET referral_level = referral_level + 1 WHERE user_id = $1",
    [currentReferrer]
  );

  // move to next referrer
  currentReferrer = refUser.referrer;
  level++;

    } 
  }catch (err) {
      console.error("Error updating referral bonus:", err);
    }
      const miner = new CryptoMiner(plan.rows[0]);
      global.miners[req.user.id] = miner;
      console.log("Global miners object:", Object.keys(global.miners));

      console.log("CryptoMiner plan created for user", req.user.username, miner);
      await transporter.sendMail({
        from: `"TrustedFinance" <${process.env.EMAIL_USER}>`,
        to: req.user.email,
        subject: 'Your Deposit is Confirmed',
        html: `
          <p>Dear ${req.user.full_name || 'User'},</p>
          <p>Your deposit has been confirmed and is now being operated.</p>
          <p>Details:</p>
          <ul>
            <li>Amount: $${plan.rows[0].confirmed_deposit}</li>
            <li>Proposed Interest Rate: ${plan.rows[0].proposedpercent *100}%</li>
            <li>Proposed Time Period: ${plan.rows[0].proposedtime/3600000} hours</li>
          </ul>
          <p>Please allow up to 24 hours for processing.</p>
          <p>If you have any questions, contact our support team.</p>
           
          <p>Best regards,<br>TrustedFinance Support Team</p>
          <small>https://trusted-finance.biz</small>
        `,
      });

      await pool.query("DELETE FROM user_deposits WHERE user_id=$1",[req.user.username])
      
      return res.json({ success: true });
    }

  } catch (err) {
    console.error("Confirm deposit error:", err);
    res.status(500).json({ error: "Failed to retrieve deposit information." });
  }
});
app.get("/api/miner/status", authenticate, minerLimiter, (req, res) => {
  
  const miner = global.miners[req.user.id];
  ;

  if (!miner) {
    return res.status(404).json({ error: "No active mining plan found" });
  }

  const status = miner.getStatus();
  res.json(status);
  
});

// Example: Withdraw
app.post("/api/miner/withdraw", authenticate, async (req, res) => {
  const miner = global.miners[req.user.id];
  

  if (!miner) {
    return res.status(404).json({ error: "No active mining plan" });
  }

  const amount = miner.withdraw();
  await pool.query(
    "INSERT INTO transactions (user_id, type, amount, description, reference) VALUES ($1, 'withdrawal', $2, 'User withdrawal', $3)",
    [req.user.id, amount, `with_${Math.floor(Math.random() * 100000)}`]
  );

  await transporter.sendMail({
    from: `"TrustedFinance" <${process.env.EMAIL_USER}>`,
    to: req.user.email,
    subject: 'Withdrawal Successful',
    html: `
      <p>Dear ${req.user.full_name || 'User'},</p>
      <p>Your withdrawal of amount has been processed successfully.</p>
      <p>Thank you for using TrustedFinance.</p>
      <p>Best regards,<br>TrustedFinance Support Team</p>
      <small>https://trusted-finance.biz</small>
    `,
  });
  delete global.miners[req.user.id];
 
  res.json({ success: true, amount });
  authLimiter.resetKey(req.ip);
});
// Get Transaction History
app.get("/api/transactions", authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT 
          id, 
          type, 
          amount, 
          currency, 
          description, 
          reference, 
          metadata, 
          created_at 
       FROM transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const countResult = await pool.query(
      "SELECT COUNT(*) FROM transactions WHERE user_id = $1",
      [req.user.id]
    );

    const total = parseInt(countResult.rows[0].count);

    res.json({
      success: true,
      transactions: result.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
    authLimiter.resetKey(req.ip);

  } catch (err) {
    console.error("Transaction history error:", err);
    res.status(500).json({ error: "Failed to fetch transaction history" });
  }
});

// Protected route example
app.get("/admin", authenticate, async (req, res) => {
 
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      ["admin"]

    );
    const adminUser = result.rows[0];
    
    res.status(200).json({ 
      success: true,
      message: "Admin access granted.",
      user: adminUser
     });
     authLimiter.resetKey(req.ip);
  } catch (err) {
    console.error("Admin access error:", err);
    res.status(500).json({ error: "Failed to verify admin access." });
  }
});

// Example protected route
app.get("/account", authenticate, (req, res) => {
  console.log("Authenticated user:", req.user);
  res.json({
    message: "Welcome to your account!",
    user: req.user,
    ip: req.ip
  });
  authLimiter.resetKey(req.ip);
});

// Start server
app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
