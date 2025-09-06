// Security-focused ESLint configuration
// This file contains security-specific rules and can be extended in the main config

module.exports = {
  rules: {
    // Prevent dangerous practices
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-script-url': 'error',
    
    // Security plugin rules
    'security/detect-object-injection': 'warn',
    'security/detect-non-literal-fs-filename': 'off', // Too many false positives in Node.js
    'security/detect-unsafe-regex': 'error',
    'security/detect-buffer-noassert': 'error',
    'security/detect-child-process': 'warn',
    'security/detect-disable-mustache-escape': 'error',
    'security/detect-eval-with-expression': 'error',
    'security/detect-no-csrf-before-method-override': 'error',
    'security/detect-non-literal-regexp': 'off', // Common pattern, many false positives
    'security/detect-non-literal-require': 'warn',
    'security/detect-possible-timing-attacks': 'off', // Too many false positives
    'security/detect-pseudoRandomBytes': 'error',
  },
};