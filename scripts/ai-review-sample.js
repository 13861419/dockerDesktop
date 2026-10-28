// AI 审查验证样例 —— 故意包含安全漏洞，用于验证 ai-review 是否能抓出问题，不合并
const { exec } = require('child_process');
const express = require('express');
const app = express();

app.get('/ping', (req, res) => {
  // 故意的命令注入示例：host 参数未转义直接拼入 shell
  exec(`ping -c 1 ${req.query.host}`, (err, stdout) => res.send(stdout));
});

app.get('/read', (req, res) => {
  // 故意的路径穿越示例：直接使用用户输入路径
  const file = fs.readFileSync(req.query.path, 'utf8');
  res.send(file);
});

app.listen(9999);
