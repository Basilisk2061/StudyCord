/* eslint-disable no-unused-vars */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * AuthCharacters — Animated study owl mascot for StudyCord auth pages.
 *
 * Props:
 *   charState: 'idle' | 'email' | 'password-hidden' | 'password-visible'
 *
 * Behaviors:
 *   idle            → eyes follow the mouse cursor
 *   email           → eyes look toward the right (toward the form panel)
 *   password-hidden → hands cover the eyes, eyes close
 *   password-visible→ hands lower slightly, eyes peek through
 */
export default function AuthCharacters({ charState = 'idle' }) {
  const containerRef = useRef(null);
  const [pupilOffset, setPupilOffset] = useState({ x: 0, y: 0 });

  // Track mouse position for eye movement
  useEffect(() => {
    // Don't track mouse when eyes are covered
    if (charState === 'password-hidden' || charState === 'password-visible') return;

    let rafId;
    const handleMouseMove = (e) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height * 0.35; // eye level
        const dx = e.clientX - centerX;
        const dy = e.clientY - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const maxOffset = 5;
        const factor = Math.min(distance / 200, 1);

        setPupilOffset({
          x: distance > 0 ? (dx / distance) * factor * maxOffset : 0,
          y: distance > 0 ? (dy / distance) * factor * maxOffset : 0,
        });
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      cancelAnimationFrame(rafId);
    };
  }, [charState]);

  // When focused on email, look toward the right side (where the form is)
  const eyeOffset = charState === 'email'
    ? { x: 4, y: 3 }
    : pupilOffset;

  const isHiding = charState === 'password-hidden';
  const isPeeking = charState === 'password-visible';
  const showHands = isHiding || isPeeking;

  return (
    <div className="auth-characters" ref={containerRef}>
      {/* Floating decorative dots */}
      <div className="auth-char-dots">
        <span className="auth-dot auth-dot--1" />
        <span className="auth-dot auth-dot--2" />
        <span className="auth-dot auth-dot--3" />
        <span className="auth-dot auth-dot--4" />
        <span className="auth-dot auth-dot--5" />
      </div>

      {/* The Study Owl — gentle breathing bob animation */}
      <motion.svg
        viewBox="0 0 200 260"
        className="auth-owl-svg"
        animate={{ y: [0, -4, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      >
        {/* ── Books (bottom layer) ── */}
        <rect x="50" y="225" width="100" height="11" rx="3" fill="#5a6872" />
        <rect x="55" y="213" width="90" height="11" rx="3" fill="#3d5f55" />
        <rect x="58" y="201" width="84" height="11" rx="3" fill="#4d7a6e" />

        {/* ── Feet ── */}
        <ellipse cx="80" cy="198" rx="12" ry="5" fill="#4d7a6e" />
        <ellipse cx="120" cy="198" rx="12" ry="5" fill="#4d7a6e" />

        {/* ── Body ── */}
        <ellipse cx="100" cy="160" rx="46" ry="42" fill="#2a2d35" />

        {/* ── Belly ── */}
        <ellipse cx="100" cy="168" rx="28" ry="25" fill="#353942" />

        {/* ── Wings (static, at body sides) ── */}
        <path
          d="M 58,132 C 40,148 36,175 48,192 C 52,195 56,188 55,178 C 52,158 54,142 58,132 Z"
          fill="#22252d"
        />
        <path
          d="M 142,132 C 160,148 164,175 152,192 C 148,195 144,188 145,178 C 148,158 146,142 142,132 Z"
          fill="#22252d"
        />

        {/* ── Ear tufts ── */}
        <polygon points="62,45 75,18 87,48" fill="#2a2d35" />
        <polygon points="113,48 125,18 138,45" fill="#2a2d35" />

        {/* ── Head ── */}
        <circle cx="100" cy="78" r="46" fill="#2a2d35" />

        {/* ── Face disc (lighter inner area) ── */}
        <circle cx="100" cy="82" r="34" fill="#353942" />

        {/* ── Eyes — conditionally rendered based on charState ── */}
        {isHiding ? (
          /* Closed eyes — simple horizontal lines */
          <>
            <line x1="70" y1="76" x2="94" y2="76" stroke="#555" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="106" y1="76" x2="130" y2="76" stroke="#555" strokeWidth="2.5" strokeLinecap="round" />
          </>
        ) : isPeeking ? (
          /* Peeking — squinting/narrowed eyes */
          <>
            <ellipse cx="82" cy="76" rx="14" ry="7" fill="#e0dbd4" />
            <circle cx={82 + eyeOffset.x * 0.5} cy={76} r="5" fill="#1a1d24" />
            <circle cx={84 + eyeOffset.x * 0.3} cy={74} r="1.5" fill="#fff" />

            <ellipse cx="118" cy="76" rx="14" ry="7" fill="#e0dbd4" />
            <circle cx={118 + eyeOffset.x * 0.5} cy={76} r="5" fill="#1a1d24" />
            <circle cx={120 + eyeOffset.x * 0.3} cy={74} r="1.5" fill="#fff" />
          </>
        ) : (
          /* Normal open eyes with tracking pupils */
          <>
            <circle cx="82" cy="76" r="14" fill="#e0dbd4" />
            <circle cx={82 + eyeOffset.x} cy={76 + eyeOffset.y} r="7" fill="#1a1d24" />
            <circle cx={85 + eyeOffset.x * 0.5} cy={73 + eyeOffset.y * 0.5} r="2.5" fill="#fff" />

            <circle cx="118" cy="76" r="14" fill="#e0dbd4" />
            <circle cx={118 + eyeOffset.x} cy={76 + eyeOffset.y} r="7" fill="#1a1d24" />
            <circle cx={121 + eyeOffset.x * 0.5} cy={73 + eyeOffset.y * 0.5} r="2.5" fill="#fff" />
          </>
        )}

        {/* ── Beak ── */}
        <polygon points="95,94 100,103 105,94" fill="#4d7a6e" />

        {/* ── Smile ── */}
        <path
          d="M 93,106 Q 100,112 107,106"
          fill="none"
          stroke="#4d4f58"
          strokeWidth="1.5"
          strokeLinecap="round"
        />

        {/* ── Hands covering eyes (animated in/out) ── */}
        <AnimatePresence>
          {showHands && (
            <motion.g
              initial={{ opacity: 0, y: 30 }}
              animate={{
                opacity: 1,
                y: isPeeking ? 12 : 0,
              }}
              exit={{ opacity: 0, y: 30 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
            >
              {/* Left hand */}
              <rect x="56" y="62" width="34" height="24" rx="12" fill="#242830" />
              {/* Left finger bumps */}
              <circle cx="64" cy="62" r="5.5" fill="#242830" />
              <circle cx="76" cy="60" r="5.5" fill="#242830" />
              <circle cx="87" cy="62" r="5.5" fill="#242830" />

              {/* Right hand */}
              <rect x="110" y="62" width="34" height="24" rx="12" fill="#242830" />
              {/* Right finger bumps */}
              <circle cx="113" cy="62" r="5.5" fill="#242830" />
              <circle cx="124" cy="60" r="5.5" fill="#242830" />
              <circle cx="136" cy="62" r="5.5" fill="#242830" />
            </motion.g>
          )}
        </AnimatePresence>
      </motion.svg>
    </div>
  );
}
