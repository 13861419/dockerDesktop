# Docker Manager APT 仓库

## 使用方法

```bash
# 导入 GPG 公钥（如已签名）
# curl -fsSL https://13861419.github.io/dockerDesktop/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/docker-manager.gpg

# 添加仓库源
echo "deb [signed-by=/usr/share/keyrings/docker-manager.gpg] https://13861419.github.io/dockerDesktop/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/docker-manager.list

# 安装
sudo apt update
sudo apt install docker-manager
```
