// Unit tests: mathHelpers
import { clamp, roundTo } from '../utils/mathHelpers.js';

console.log('Testing clamp:', clamp(15, 0, 10) === 10);
console.log('Testing roundTo:', roundTo(3.14159, 2) === 3.14);

// Revision 20 - 2026-09-21
