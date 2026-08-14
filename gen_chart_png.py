# -*- coding: utf-8 -*-
"""用 matplotlib 重绘"漏洞风险等级分布"柱状图并导出 PNG"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

# 中文字体支持：优先使用常见中文字体
for name in ["Microsoft YaHei", "SimHei", "SimSun", "Arial Unicode MS"]:
    try:
        font_manager.findfont(name, fallback_to_default=False)
        plt.rcParams["font.sans-serif"] = [name] + plt.rcParams.get("font.sans-serif", [])
        break
    except Exception:
        continue
plt.rcParams["axes.unicode_minus"] = False

levels = ["高危", "中危", "低"]
counts = [2, 5, 6]
colors = ["#C00000", "#ED7D31", "#FFC000"]

fig, ax = plt.subplots(figsize=(7.5, 5.2), dpi=150)
bars = ax.bar(levels, counts, color=colors, width=0.55, edgecolor="none")

ax.set_title("DockerDesktop 安全审计 —— 漏洞风险等级分布", fontsize=15, fontweight="bold", pad=16)
ax.set_ylabel("数量（项）", fontsize=12)
ax.set_ylim(0, 7.5)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.grid(axis="y", linestyle="--", alpha=0.35)
ax.set_axisbelow(True)

total = sum(counts)
for bar, n in zip(bars, counts):
    ax.text(
        bar.get_x() + bar.get_width() / 2,
        bar.get_height() + 0.12,
        f"{n}\n({n/total:.0%})",
        ha="center",
        va="bottom",
        fontsize=12,
        fontweight="bold",
    )

out = r"f:\ai_work\dockerDesktop\docs\security-audit-risk-chart-2026-08-14.png"
fig.savefig(out, bbox_inches="tight", facecolor="white")
print("saved png:", out)
