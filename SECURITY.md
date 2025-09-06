# Security Guidelines

## Overview

This project includes linting and security scanning tools to help maintain code quality and security compliance.

## Tools Installed

### ESLint with Security Plugin
- **Purpose**: Code quality and security linting
- **Configuration**: `eslint.config.js`
- **Security Rules**: Enabled via `eslint-plugin-security`

### Available Scripts

```bash
# Run all checks (typecheck + lint + security)
pnpm run check

# Linting
pnpm run lint          # Check for issues
pnpm run lint:fix      # Auto-fix issues where possible

# Security
pnpm run security:audit    # Basic security audit
pnpm run security:deps     # Check for outdated/vulnerable dependencies
pnpm run security:check    # Run all security checks
```

## Security Rules Enforced

### Critical (Errors)
- No use of `eval()` or `new Function()`
- No unsafe regex patterns
- No deprecated buffer methods
- Detection of potential XSS vulnerabilities

### Warnings
- Object injection patterns (with context awareness)
- Child process usage
- Non-literal require statements

### Disabled (Too many false positives)
- Non-literal filesystem paths (common in Node.js)
- Timing attack detection
- Non-literal regex (common pattern)

## Best Practices

1. **Dependencies**: Regularly update dependencies and check for vulnerabilities
2. **Environment Variables**: Never commit secrets or API keys
3. **Input Validation**: Always validate and sanitize user inputs
4. **Error Handling**: Don't expose sensitive information in error messages
5. **Logging**: Avoid logging sensitive data

## Manual Security Checks

While automated tools help, also manually review:
- Authentication and authorization logic
- Data validation and sanitization
- Error handling and logging
- Third-party integrations
- File system operations

## Reporting Security Issues

If you discover a security vulnerability, please:
1. Do not open a public GitHub issue
2. Contact the maintainers directly
3. Provide detailed information about the vulnerability
4. Allow time for the issue to be addressed before public disclosure