// security-test-sample.js - 故意放置的假密钥（AWS 官方文档公开示例），验证 gitleaks 后删除
const AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const GITHUB_TOKEN = "ghp_" + "x".repeat(36);
module.exports = { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN };
