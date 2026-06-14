/* eslint-disable no-unused-vars */
import { useEffect } from 'react';
import { motion, useMotionValue, useMotionTemplate, animate } from 'framer-motion';

const COLORS = [
  '#000000',
  '#050505',
  '#0a0a0a',
  '#0f0f0f',
];

export default function EtherealBackground({ children }) {
  const color = useMotionValue(COLORS[0]);
  const bgGradient = useMotionTemplate`radial-gradient(ellipse 100% 80% at 30% 20%, ${color}, transparent)`;

  useEffect(() => {
    const controls = animate(color, COLORS, {
      duration: 12,
      repeat: Infinity,
      repeatType: 'mirror',
      ease: 'easeInOut',
    });
    return () => controls.stop();
  }, [color]);

  return (
    <div className="ethereal-wrapper">
      {/* Dark grid pattern */}
      <div className="ethereal-grid" />

      {/* Animated glow */}
      <motion.div className="ethereal-glow" style={{ backgroundImage: bgGradient }} />

      {/* Secondary static glow */}
      <div className="ethereal-glow-secondary" />

      {/* Noise grain */}
      <div className="ethereal-noise" />

      {/* Content */}
      <div className="ethereal-content">
        {children}
      </div>
    </div>
  );
}
