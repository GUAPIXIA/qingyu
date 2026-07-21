---
name: java-spring-vue-shop
description: Java Spring Boot + Vue 微服务商城项目开发工作流。适用于 Spring Boot 后端 + Vue 前端的电商/商城类项目，包含 Maven 配置、Controller 开发、Vue 组件编写、数据库操作等常见模式。
---

# Java Spring Boot + Vue 微服务商城开发

## 适用场景

当用户需要开发或维护基于以下技术栈的项目时使用：
- **后端**: Java 8/17, Spring Boot, Spring Cloud, MyBatis/MyBatis-Plus
- **前端**: Vue 2/3, Element UI/Ant Design, Axios
- **数据库**: MySQL, Redis
- **构建工具**: Maven, npm/yarn
- **微服务**: Nacos, Gateway, Feign

## 典型项目结构

```
project/
├── shop-gateway/          # API 网关
├── shop-auth/             # 认证服务
├── shop-modules/          # 业务模块
│   ├── shop-modules-order/
│   ├── shop-modules-goods/
│   ├── shop-modules-user/
│   └── shop-modules-file/
├── shop-web/              # 前端 (Vue)
├── shop-admin/            # 管理后台 (Vue)
└── pom.xml                # 父 POM
```

## 开发工作流

### 1. 项目初始化/配置

**检查配置文件:**
- `pom.xml` - Maven 依赖管理
- `application-{env}.yml` - Spring 配置
- `bootstrap.yml` - Nacos 配置中心
- `vite.config.js` / `vue.config.js` - 前端构建配置

**常见操作:**
```bash
# 后端构建
mvn clean package -DskipTests
mvn spring-boot:run

# 前端启动
cd shop-web && npm install && npm run dev
cd shop-admin && npm install && npm run dev
```

### 2. 后端开发模式

**Controller 层:**
```java
@RestController
@RequestMapping("/api/xxx")
public class XxxController {
    @Autowired
    private XxxService xxxService;
    
    @GetMapping("/list")
    public Result list(@RequestParam Map<String, Object> params) {
        // 分页查询
    }
    
    @PostMapping("/save")
    public Result save(@RequestBody XxxEntity entity) {
        // 保存/更新
    }
}
```

**Service 层:**
- 继承 `IService<Entity>` 或自定义接口
- 使用 `@Transactional` 管理事务

**Mapper 层:**
- MyBatis-Plus: 继承 `BaseMapper<Entity>`
- XML 映射文件: `resources/mapper/XxxMapper.xml`

### 3. 前端开发模式

**Vue 组件结构:**
```vue
<template>
  <div>
    <!-- 表格/表单/列表 -->
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getXxxList, saveXxx } from '@/api/xxx'

const tableData = ref([])
const loading = ref(false)

onMounted(() => {
  fetchData()
})
</script>
```

**API 调用:**
```javascript
// api/xxx.js
import request from '@/utils/request'

export function getXxxList(params) {
  return request({ url: '/api/xxx/list', method: 'get', params })
}
```

### 4. 数据库操作

**MySQL 常用命令:**
```sql
-- 查看表结构
DESCRIBE table_name;
SHOW CREATE TABLE table_name;

-- 常见操作
SELECT * FROM table_name WHERE condition;
INSERT INTO table_name (col1, col2) VALUES (val1, val2);
UPDATE table_name SET col1 = val1 WHERE condition;
DELETE FROM table_name WHERE condition;
```

**初始化脚本位置:**
- `sql/` 或 `db/` 目录下的 `.sql` 文件
- Flyway/Liquibase 迁移脚本

## 常见问题排查

### 1. 启动失败
- 检查端口占用: `netstat -ano | findstr :8080`
- 检查 Nacos 连接: 确认 `bootstrap.yml` 配置
- 检查数据库连接: 确认 `application-dev.yml` 中的 MySQL 配置

### 2. 前端 API 调用失败
- 检查 `vite.config.js` 中的代理配置
- 检查 Gateway 路由配置
- 查看浏览器 Network 面板的请求详情

### 3. 数据库问题
- 检查 SQL 语法: 使用 Navicat 或命令行测试
- 检查字段映射: 实体类字段与数据库列名对应
- 检查事务: 确认 `@Transactional` 配置

## 文件操作优先级

当需要修改代码时，按以下顺序:
1. **Controller** - API 接口层
2. **Service** - 业务逻辑层
3. **Mapper/Repository** - 数据访问层
4. **Entity/Model** - 实体类
5. **Vue 组件** - 前端页面
6. **配置文件** - application.yml, pom.xml

## 快速定位文件

```bash
# 查找 Controller
find . -name "*Controller.java"

# 查找配置文件
find . -name "application*.yml" -o -name "bootstrap*.yml"

# 查找 Vue 页面
find . -name "*.vue" -path "*/views/*"
```
