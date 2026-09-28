# Docker Manager APT 仓库

## 使用方法

```bash
# 添加仓库源（Pages 托管为未签名源，使用 trusted=yes）
echo "deb [trusted=yes] https://13861419.github.io/dockerDesktop/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/docker-manager.list

# 安装
sudo apt update
sudo apt install docker-manager
```
