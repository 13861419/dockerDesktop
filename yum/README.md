# Docker Manager YUM 仓库

## 使用方法

```bash
# 添加仓库源
cat > /etc/yum.repos.d/docker-manager.repo <<EOF
[docker-manager]
name=Docker Manager
baseurl=https://13861419.github.io/dockerDesktop/yum
enabled=1
gpgcheck=0
EOF

# 安装
yum install docker-manager
# 或
dnf install docker-manager
```
