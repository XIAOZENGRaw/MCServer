# Minecraft服务器查询API 
这是使用Bun运行时的空旷Minecraft服务器查询API。

## 功能

- 查询Java版Minecraft服务器状态
- 查询基岩版(Bedrock)Minecraft服务器状态（优化速度）
- 自动识别服务器类型（Java版或基岩版）
- 获取服务器版本、在线人数、最大人数等信息
- 精确测量服务器延迟(ping)，针对Java版和基岩版分别优化
- 并行查询优化，提高自动识别速度

## 安装

确保已安装Bun：

```bash
# 安装Bun (如果尚未安装)
curl -fsSL https://bun.sh/install | bash
```

安装依赖：

```bash
cd bun
bun install
```

## 配置

创建`.env`文件并设置以下变量：

```
PORT=3000
NODE_ENV=production
```

## 运行

### 开发模式

```bash
bun dev
```

### 生产模式

```bash
bun start
```

## API接口

### 健康检查

```
GET /
```

响应：

```json
{
  "success": true,
  "message": "空旷API运行正常",
  "time": "2023-06-01T12:00:00.000Z"
}
```

### 查询Minecraft服务器

```
GET /mcserver?ip=服务器IP&port=服务器端口&edition=服务器版本&auto=是否自动识别
```

参数：
- `ip`: 服务器IP或域名 (必填)
- `port`: 服务器端口 (可选，Java版默认25565，基岩版默认19132)
- `edition`: 服务器版本 (可选，"java"或"bedrock"，默认为"java")
- `auto`: 是否自动识别服务器类型 (可选，"true"或"false"，默认为"false")

响应示例：

```json
{
  "success": true,
  "data": {
    "version": "1.20.4",
    "online_players": 10,
    "max_players": 100,
    "description": "这是一个Minecraft服务器",
    "favicon": "data:image/png;base64,...",
    "ping": 50,
    "server_address": "mc.example.com:25565",
    "edition": "java"
  }
}
```

当启用自动识别时（`auto=true`），系统会并行查询Java版和基岩版：

```json
{
  "success": true,
  "data": {
    "version": "1.20.4",
    "online_players": 10,
    "max_players": 100,
    "description": "这是一个Minecraft服务器",
    "favicon": "data:image/png;base64,...",
    "ping": 50,
    "server_address": "mc.example.com:25565",
    "edition": "java"
  },
  "detected": true,
  "type": "java"
}
```

### 专门查询基岩版服务器

```
GET /bedrock?ip=服务器IP&port=服务器端口
```

参数：
- `ip`: 服务器IP或域名 (必填)
- `port`: 服务器端口 (可选，默认19132)

响应示例：

```json
{
  "success": true,
  "data": {
    "version": "1.20.4",
    "online_players": 5,
    "max_players": 50,
    "description": "这是一个基岩版Minecraft服务器",
    "ping": 30,
    "server_address": "mc.example.com:19132",
    "edition": "bedrock"
  }
}
```

### 自动识别服务器类型

```
GET /auto?ip=服务器IP&javaPort=Java版端口&bedrockPort=基岩版端口
```

参数：
- `ip`: 服务器IP或域名 (必填)
- `javaPort`: Java版服务器端口 (可选，默认25565)
- `bedrockPort`: 基岩版服务器端口 (可选，默认19132)

响应示例：

```json
{
  "success": true,
  "data": {
    "version": "1.20.4",
    "online_players": 10,
    "max_players": 100,
    "description": "这是一个Minecraft服务器",
    "ping": 50,
    "server_address": "mc.example.com:25565",
    "edition": "java"
  },
  "detected": true,
  "type": "java"
}
```

如果自动识别失败：

```json
{
  "success": false,
  "message": "无法自动检测服务器类型，请手动指定edition参数",
  "error": "自动检测失败",
  "javaError": "连接超时",
  "bedrockError": "连接被拒绝"
}
```

## 性能优化

API采用多种技术优化性能和响应速度：

1. **并行查询**：
   - 自动识别模式下同时查询Java版和基岩版服务器
   - 使用Promise.race机制，一旦有服务器响应就立即返回结果
   - 大幅提高自动识别速度，通常仅需等待最快响应的服务器

2. **基岩版查询优化**：
   - 减少基岩版查询超时时间从原来的默认值到只有2秒
   - 简化基岩版ping测量，减少ping请求次数，加快响应
   - 为基岩版查询增加单独的超时控制，不影响Java版查询
   - 在自动识别中优先处理更快响应的查询结果

3. **超时控制**：
   - 所有查询设置合理的超时限制
   - Java版查询保持5秒超时
   - 基岩版查询减少至2秒超时
   - 基岩版ping测量减少至1.2秒超时
   - 避免查询卡住，确保API快速响应

4. **优化的延迟测量**：
   - Java版使用TCP连接测量网络延迟
   - 基岩版使用优化的UDP协议直接测量延迟，且使用平均值计算替代中位数，提高速度

## 延迟测量方法

API采用不同的方法测量Java版和基岩版服务器的延迟：

### Java版延迟测量
- 使用TCP连接时间测量网络延迟
- 从服务器响应中获取ping值
- 选择最准确的一种作为最终值

### 基岩版延迟测量
- 使用优化的UDP协议直接测量延迟
- 发送较少的ping请求（仅2次），减少等待时间
- 使用平均值而非中位数计算，加快处理速度
- 设置更短的超时时间（1.2秒），避免长时间等待
- 提供更快的响应，避免不必要的延迟

## 与Node.js版本的区别

- 使用ESM模块系统而非CommonJS
- 使用Bun的热重载功能进行开发
- 性能更好，启动更快
- 增加了对基岩版Minecraft服务器的支持
- 支持自动识别服务器类型（Java版或基岩版）
- 优化了基岩版服务器的延迟测量方法
- 对基岩版查询流程进行了特别优化，减少查询时间 
