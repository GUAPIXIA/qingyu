---
description: 排查运行时错误。分析错误日志、堆栈跟踪，定位问题根源并提供修复方案。适用于启动失败、运行报错、API 异常等场景。
---

# 排查运行时错误

## 使用方式

```
/diagnose-error <错误描述或日志>
```

用户可以直接粘贴错误日志，或者描述遇到的问题。

## 排查工作流

### 1. 错误信息收集

- 解析用户提供的错误日志
- 识别关键信息：
  - 错误类型 (Exception class)
  - 错误消息
  - 堆栈跟踪 (stack trace)
  - 发生时间
  - 相关文件和行号

### 2. 分类错误类型

**Java/Spring Boot 错误:**
- `NullPointerException` - 空指针异常
- `ClassNotFoundException` - 类未找到
- `BeanCreationException` - Bean 创建失败
- `SQLException` - 数据库错误
- `ConnectException` - 连接失败

**前端/Vue 错误:**
- `TypeError` - 类型错误
- `Network Error` - 网络请求失败
- `SyntaxError` - 语法错误
- `Component not found` - 组件未注册

**数据库错误:**
- `Table doesn't exist` - 表不存在
- `Duplicate entry` - 重复数据
- `Foreign key constraint` - 外键约束

### 3. 定位问题根源

**检查顺序:**
1. **配置文件** - 检查相关配置是否正确
   - `application.yml` / `application.properties`
   - `vite.config.js` / `vue.config.js`
   - `pom.xml` / `package.json`

2. **依赖问题** - 检查依赖是否完整
   - Maven: `mvn dependency:tree`
   - npm: `npm ls`

3. **代码逻辑** - 检查相关代码
   - 读取错误堆栈中的文件
   - 检查变量初始化
   - 检查空值处理

4. **环境问题** - 检查运行环境
   - 端口占用: `netstat -ano | findstr :端口号`
   - 进程状态: `tasklist | findstr 进程名`
   - 环境变量

### 4. 提供修复方案

根据问题类型提供：
- **立即修复**: 直接修改代码或配置
- **临时绕过**: 快速解决方案
- **根本解决**: 长期修复建议

### 5. 验证修复

- 应用修复方案
- 运行项目验证
- 确认错误不再出现

## 常见错误速查表

### Spring Boot 启动失败
```
Error: Application run failed
→ 检查 @SpringBootApplication 注解
→ 检查组件扫描路径
→ 检查 Bean 依赖注入
```

### Vue 组件渲染失败
```
Error: Component not found
→ 检查组件导入路径
→ 检查组件注册
→ 检查组件名称拼写
```

### 数据库连接失败
```
Error: Connection refused
→ 检查数据库服务是否启动
→ 检查连接配置 (host, port, username, password)
→ 检查防火墙设置
```

### API 调用失败
```
Error: Network Error / CORS
→ 检查后端服务是否运行
→ 检查 API 路径是否正确
→ 检查代理配置 / CORS 配置
```

## 排查工具

```bash
# 查看日志
tail -f logs/app.log

# 检查端口
netstat -ano | findstr :8080

# 检查进程
tasklist | findstr java

# 检查网络
ping localhost
curl http://localhost:8080/api/test
```
