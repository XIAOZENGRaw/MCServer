import { config } from 'dotenv';
import express from 'express';
import mcping from 'mc-ping-updated';
import { createConnection } from 'net';
import { ping as bedrockPing } from 'bedrock-protocol';
import dgram from 'dgram';

config();
const app = express();
const port = process.env.PORT || 3000;

// 中间件
app.use(express.json());

// 添加CORS头，允许所有域名访问API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// 主路由
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'API运行正常',
    time: new Date().toISOString()
  });
});

// 全局追踪活动的UDP套接字
global.activeSockets = [];

// 更精简高效的基岩版ping测量
async function measureBedrockPing(ip, port, attempts = 2) {
  return new Promise((resolve) => {
    // 创建UDP客户端
    const client = dgram.createSocket('udp4');
    
    // 追踪这个套接字
    global.activeSockets.push(client);
    
    const pings = [];
    let attemptCount = 0;
    let timeoutId;
    let closed = false;
    
    // 安全关闭客户端的函数
    const safeClose = () => {
      if (!closed) {
        closed = true;
        try {
          client.close();
          // 从活动套接字列表中移除
          const index = global.activeSockets.indexOf(client);
          if (index !== -1) {
            global.activeSockets.splice(index, 1);
          }
        } catch (e) {
          // 忽略关闭错误
        }
      }
    };
    
    // 简单的基岩版ping包数据
    const pingPacket = Buffer.from([
      0x01, // Unconnected Ping
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 时间戳（8字节）
      0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, // Magic
      0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78  // Magic续 + 客户端ID
    ]);
    
    // 当收到消息时
    client.on('message', () => {
      const endTime = Date.now();
      const pingTime = endTime - startTimes[attemptCount - 1];
      pings.push(pingTime);
      
      // 如果已完成所有尝试，计算平均值并返回
      if (pings.length >= attempts) {
        clearTimeout(timeoutId);
        safeClose();
        
        // 取平均值而不是中位数，加快计算
        if (pings.length > 0) {
          const avgPing = pings.reduce((a, b) => a + b, 0) / pings.length;
          resolve(Math.floor(avgPing));
        } else {
          resolve(null);
        }
      } else {
        // 继续发送下一个ping包
        sendPing();
      }
    });
    
    // 错误处理
    client.on('error', () => {
      clearTimeout(timeoutId);
      safeClose();
      resolve(null);
    });
    
    // 确保在进程退出时关闭套接字
    client.unref();
    
    // 存储每次发送的开始时间
    const startTimes = [];
    
    // 发送ping包函数
    function sendPing() {
      if (attemptCount >= attempts || closed) return;
      
      startTimes[attemptCount] = Date.now();
      attemptCount++;
      
      try {
        client.send(pingPacket, port, ip);
      } catch (e) {
        // 忽略发送错误
      }
    }
    
    // 设置整体超时为1.2秒
    timeoutId = setTimeout(() => {
      // 如果有一些有效的ping值，返回其平均值
      if (pings.length > 0) {
        const avgPing = pings.reduce((a, b) => a + b, 0) / pings.length;
        resolve(Math.floor(avgPing));
      } else {
        resolve(null);
      }
      safeClose();
    }, 1200);
    
    // 开始第一次ping
    sendPing();
  });
}

// 基岩版查询函数
async function queryBedrockServer(ip, port) {
  try {
    // 使用更快的方式直接查询基岩版服务器信息
    // 设置超时控制，最多等待2秒
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('基岩版查询超时')), 2000)
    );

    // 先进行快速的ping测量
    const pingValue = await Promise.race([
      measureBedrockPing(ip, port, 2), // 减少尝试次数到2次
      new Promise((_, reject) => setTimeout(() => reject(new Error('Ping测量超时')), 1500))
    ]).catch(() => 100); // 如果ping测量失败，使用默认值
    
    // 使用更快速的超时设置进行服务器查询
    const bedrockQueryPromise = bedrockPing({ 
      host: ip, 
      port: port,
      timeout: 1500 // 减少内部超时到1.5秒
    });
    
    // 等待查询结果，设置超时
    const result = await Promise.race([bedrockQueryPromise, timeoutPromise]);
    
    // 最终的ping值：优先使用UDP测量值，如果没有则使用整体查询时间
    const finalPing = pingValue || 100;
    
    return {
      success: true,
      data: {
        version: result.version,
        online_players: result.playersOnline,
        max_players: result.playersMax,
        description: result.motd,
        ping: Math.min(finalPing, 1000), // 限制最大值为1000ms
        server_address: `${ip}:${port}`,
        edition: 'bedrock'
      }
    };
  } catch (error) {
    return {
      success: false,
      message: '无法连接到基岩版服务器或服务器未响应',
      error: error.message
    };
  }
}

// Java版查询函数
async function queryJavaServer(ip, port) {
  try {
    // 使用TCP连接测量真实的ping值
    const pingPromise = new Promise((resolve) => {
      const startTime = Date.now();
      const socket = createConnection(port, ip);
      
      socket.on('connect', () => {
        const pingTime = Date.now() - startTime;
        socket.end();
        resolve(pingTime);
      });
      
      socket.on('error', () => {
        resolve(null); // 连接失败，返回null
      });
      
      // 设置超时
      socket.setTimeout(3000, () => {
        socket.destroy();
        resolve(null);
      });
    });

    // 同时进行MC服务器查询和ping测试
    const mcpingPromise = new Promise((resolve, reject) => {
      mcping(ip, port, (err, data) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(data);
      }, 3000);
    });

    // 等待两个Promise完成
    const [pingResult, mcData] = await Promise.allSettled([pingPromise, mcpingPromise]);
    
    if (mcData.status === 'rejected') {
      return {
        success: false,
        message: '无法连接到Java版服务器或服务器未响应',
        error: mcData.reason.message
      };
    }

    const data = mcData.value;
    
    // 处理服务器描述，可能是字符串或对象
    let description = '';
    if (typeof data.description === 'string') {
      description = data.description;
    } else if (data.description && data.description.text) {
      description = data.description.text;
    } else if (data.description && data.description.extra) {
      // 只提取文本内容，忽略颜色和格式
      description = data.description.extra.map(part => {
        if (typeof part === 'string') return part;
        return part.text || '';
      }).join('');
    }

    // 清理描述中的特殊格式符号（§ 加颜色代码）
    description = description.replace(/§[0-9a-fklmnor]/gi, '');
    
    // 处理版本信息，可能是字符串或对象
    let version = '';
    if (typeof data.version === 'string') {
      version = data.version;
    } else if (data.version && data.version.name) {
      // 从name字段中提取版本号，通常格式为"xxx 1.21.4"或类似格式
      const versionMatch = data.version.name.match(/(\d+\.\d+\.\d+|\d+\.\d+)/);
      if (versionMatch) {
        version = versionMatch[0]; // 提取匹配到的版本号
      } else {
        version = data.version.name; // 如果没有匹配到版本号，使用原始name
      }
    } else if (data.version && typeof data.version === 'object') {
      version = JSON.stringify(data.version);
    }

    // 确定最终的ping值
    let finalPing;
    
    // 首先尝试使用TCP连接测量的ping
    if (pingResult.status === 'fulfilled' && pingResult.value !== null) {
      finalPing = pingResult.value;
    } 
    // 然后尝试使用MC服务器返回的ping
    else if (data && typeof data.ping === 'number' && !isNaN(data.ping) && data.ping > 0) {
      finalPing = data.ping;
    }
    // 最后使用默认值
    else {
      finalPing = 100;
    }

    // 确保ping值在合理范围内
    finalPing = Math.max(1, Math.min(finalPing, 1000));

    return {
      success: true,
      data: {
        version: version,
        online_players: data.players.online,
        max_players: data.players.max,
        description: description,
        favicon: data.favicon,
        ping: finalPing,
        server_address: `${ip}:${port}`,
        edition: 'java'
      }
    };
  } catch (error) {
    return {
      success: false,
      message: '无法连接到Java版服务器或服务器未响应',
      error: error.message
    };
  }
}

// 自动检测服务器类型
async function autoDetectServerType(ip, javaPort = 25565, bedrockPort = 19132) {
  // 并行查询Java版和基岩版，但给基岩版更短的超时时间
  const javaPromise = queryJavaServer(ip, javaPort).catch(err => ({ 
    success: false, 
    message: '无法连接到Java版服务器', 
    error: err.message 
  }));
  
  const bedrockPromise = new Promise(async (resolve) => {
    // 给基岩版查询单独设置更短的超时
    const result = await Promise.race([
      queryBedrockServer(ip, bedrockPort),
      new Promise((_, reject) => setTimeout(() => reject(new Error('基岩版查询超时')), 2000))
    ]).catch(err => ({ 
      success: false, 
      message: '无法连接到基岩版服务器', 
      error: err.message 
    }));
    
    resolve(result);
  });
  
  // 使用Promise.race让先完成的查询返回结果
  const fastResult = await Promise.race([
    javaPromise.then(result => result.success ? { ...result, type: 'java' } : null),
    bedrockPromise.then(result => result.success ? { ...result, type: 'bedrock' } : null)
  ]).catch(() => null);
  
  // 如果有快速成功的结果，直接返回
  if (fastResult) {
    return {
      ...fastResult,
      detected: true
    };
  }
  
  // 否则等待两个查询都完成
  const [javaResult, bedrockResult] = await Promise.all([javaPromise, bedrockPromise]);
  
  // 优先返回Java版结果
  if (javaResult.success) {
    return {
      ...javaResult,
      detected: true,
      type: 'java'
    };
  }
  
  // 其次返回基岩版结果
  if (bedrockResult.success) {
    return {
      ...bedrockResult,
      detected: true,
      type: 'bedrock'
    };
  }
  
  // 都连接失败，返回错误
  return {
    success: false,
    message: '无法自动检测服务器类型，请手动指定edition参数',
    error: '自动检测失败',
    javaError: javaResult.error,
    bedrockError: bedrockResult.error
  };
}

// 路由：查询MC服务器信息
app.get('/mcserver', async (req, res) => {
  const { ip, port, edition, auto = 'false' } = req.query;
  
  if (!ip) {
    return res.status(400).json({
      success: false,
      message: '请提供服务器IP或域名'
    });
  }

  try {
    // 确定端口
    let serverPort;
    if (port) {
      serverPort = parseInt(port, 10);
      if (isNaN(serverPort) || serverPort <= 0 || serverPort > 65535) {
        return res.status(400).json({
          success: false,
          message: '无效的端口号，端口必须是1-65535之间的数字'
        });
      }
    } else {
      // 如果没有指定端口，根据edition使用默认端口
      serverPort = edition && edition.toLowerCase() === 'bedrock' ? 19132 : 25565;
    }

    // 自动检测服务器类型
    if (auto.toLowerCase() === 'true') {
      // 设置整体超时，最长等待5秒
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('自动检测超时')), 5000)
      );
      
      try {
        const detectionResult = await Promise.race([
          autoDetectServerType(ip, 
            serverPort,
            serverPort === 25565 ? 19132 : serverPort
          ),
          timeoutPromise
        ]);
        
        if (detectionResult.success) {
          return res.json(detectionResult);
        } else {
          return res.status(404).json(detectionResult);
        }
      } catch (error) {
        // 超时或其他错误
        return res.status(408).json({
          success: false,
          message: '自动检测服务器类型超时，请手动指定edition参数或稍后再试',
          error: error.message
        });
      }
    }

    // 如果是基岩版，调用基岩版查询函数
    if (edition && edition.toLowerCase() === 'bedrock') {
      const bedrockResult = await queryBedrockServer(ip, serverPort);
      if (bedrockResult.success) {
        return res.json(bedrockResult);
      } else {
        return res.status(404).json(bedrockResult);
      }
    } else {
      // 默认为Java版
      const javaResult = await queryJavaServer(ip, serverPort);
      if (javaResult.success) {
        return res.json(javaResult);
      } else {
        return res.status(404).json(javaResult);
      }
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: '服务器内部错误',
      error: error.message
    });
  }
});

// 路由：查询基岩版MC服务器信息
app.get('/bedrock', async (req, res) => {
  const { ip, port = 19132 } = req.query;
  
  if (!ip) {
    return res.status(400).json({
      success: false,
      message: '请提供服务器IP或域名'
    });
  }

  try {
    // 将端口转换为数字
    const serverPort = parseInt(port, 10);
    
    if (isNaN(serverPort) || serverPort <= 0 || serverPort > 65535) {
      return res.status(400).json({
        success: false,
        message: '无效的端口号，端口必须是1-65535之间的数字'
      });
    }

    const bedrockResult = await queryBedrockServer(ip, serverPort);
    if (bedrockResult.success) {
      return res.json(bedrockResult);
    } else {
      return res.status(404).json(bedrockResult);
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: '服务器内部错误',
      error: error.message
    });
  }
});

// 路由：自动检测服务器类型并查询信息
app.get('/auto', async (req, res) => {
  const { ip, javaPort = 25565, bedrockPort = 19132 } = req.query;
  
  if (!ip) {
    return res.status(400).json({
      success: false,
      message: '请提供服务器IP或域名'
    });
  }

  try {
    // 将端口转换为数字
    const javaServerPort = parseInt(javaPort, 10);
    const bedrockServerPort = parseInt(bedrockPort, 10);
    
    if (isNaN(javaServerPort) || javaServerPort <= 0 || javaServerPort > 65535) {
      return res.status(400).json({
        success: false,
        message: '无效的Java版端口号，端口必须是1-65535之间的数字'
      });
    }
    
    if (isNaN(bedrockServerPort) || bedrockServerPort <= 0 || bedrockServerPort > 65535) {
      return res.status(400).json({
        success: false,
        message: '无效的基岩版端口号，端口必须是1-65535之间的数字'
      });
    }

    // 设置整体超时，最长等待5秒
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('自动检测超时')), 5000)
    );
    
    try {
      const detectionResult = await Promise.race([
        autoDetectServerType(ip, javaServerPort, bedrockServerPort),
        timeoutPromise
      ]);
      
      if (detectionResult.success) {
        return res.json(detectionResult);
      } else {
        return res.status(404).json(detectionResult);
      }
    } catch (error) {
      // 超时或其他错误
      return res.status(408).json({
        success: false,
        message: '自动检测服务器类型超时，请手动指定edition参数或稍后再试',
        error: error.message
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: '服务器内部错误',
      error: error.message
    });
  }
});

// 404处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: '接口不存在'
  });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  res.status(500).json({
    success: false,
    message: '服务器内部错误',
    error: process.env.NODE_ENV === 'development' ? err.message : '请联系管理员'
  });
});

// 启动服务器
const server = app.listen(port, () => {
  console.log(`API服务器运行在${port}端口`);
});

// 优雅退出处理
let isShuttingDown = false;

process.on('SIGINT', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('接收到SIGINT信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已安全关闭');
    // 不使用process.exit，让Bun自然退出
  });
  
  // 清理任何可能的UDP连接
  setTimeout(() => {
    if (global.activeSockets && Array.isArray(global.activeSockets)) {
      global.activeSockets.forEach(socket => {
        try {
          if (socket && typeof socket.close === 'function') {
            socket.close();
          }
        } catch (e) {
          // 忽略关闭错误
        }
      });
    }
  }, 100);
});

process.on('SIGTERM', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('接收到SIGTERM信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已安全关闭');
    // 不使用process.exit，让Bun自然退出
  });
}); 