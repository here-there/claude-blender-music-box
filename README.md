# 八音盒（Music Box）

一个运行在浏览器里的 3D 八音盒：用 WebGPU（vgpu）实时渲染，Web Audio 合成钢齿的拨奏声。上弦、开盖，滚筒上的钉子依次拨动钢齿，随着发条放松，旋律渐渐变慢直至停下。

内置曲目：《给爱丽丝》《卡农》《小星星》《千年等一回》。

> 《千年等一回》从主歌起，按原唱简谱（1=G）移到 F 调编曲，滚筒转一圈约 73 秒。
>
> 注意：《千年等一回》并非公有领域作品（应用户要求收录），仓库中只包含旋律音符数据，不含任何歌词。其余曲目为公有领域作品。

## 运行要求

- 支持 WebGPU 的**桌面浏览器**：Chrome 或 Edge（建议 113 及以上版本）。
- 不支持 WebGPU 时页面会显示提示面板。

## 开发

```sh
pnpm install        # 安装依赖
pnpm dev            # 启动开发服务器
pnpm test           # 运行单元测试（vitest）
pnpm check          # 用 vgpu 检查所有 WGSL 着色器
pnpm build          # 类型检查并构建到 dist/
pnpm model          # 重新生成 public/musicbox.glb 与 meta（需要 /Applications/Blender.app，Blender 5.2）
```

调试参数：在地址后加 `?slow=0.25`（取值范围 (0, 1]），可把时间放慢到 0.25 倍，便于观察机械动作。

## 使用方法

- 拖动：环绕观察
- 滚轮：缩放
- 双击：复位视角
- 转到盒底，拖动钥匙绕圈：上弦（有棘轮咔嗒声）
- 点击盒盖：开合；开盖后开始演奏
- 鼠标悬停在部件上：显示说明
- 右上角：切换曲目

发条将尽时，转速按 √张力 平滑下降，每首曲子都在约 10 秒内逐渐变慢直至完全停止（减速起点按曲速计算）；再次上弦即可继续。

## 目录

```
blender/     Blender 脚本，生成模型（build_musicbox.py）
public/      musicbox.glb 与 musicbox.meta.json（模型及机械参数）
src/
  app/         错误面板（不支持 WebGPU、加载失败、设备丢失）
  audio/       Web Audio 引擎与钢齿音色
  geometry/    钢齿梳与滚筒钉子的几何计算
  gltf/        GLB 解析与上传到 GPU
  interaction/ 轨道相机、拾取、上弦手势、悬停说明、界面
  mechanism/   发条、转速与拨奏事件
  render/      渲染器、相机、环境光、振动，以及 shaders/*.wgsl
  songs/       曲库、编曲（音符到钢齿与钉子）
tests/       单元测试
docs/        设计与计划文档
```
