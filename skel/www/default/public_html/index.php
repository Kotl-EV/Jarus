<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NestCP</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center;
      font-family: ui-sans-serif, system-ui, sans-serif; background:#0b1220; color:#e2e8f0; }
    .card { width:min(520px, 92vw); background:#111827; border:1px solid #1f2937;
      border-radius:20px; padding:36px; }
    h1 { margin:0 0 8px; }
    p { color:#94a3b8; }
    code { background:#0b1220; padding:2px 6px; border-radius:6px; color:#5eead4; }
  </style>
</head>
<body>
  <div class="card">
    <h1>NestCP готов</h1>
    <p>Добавьте домен в панели NestCP. Файлы сайта — в <code>www/домен/public_html</code>.</p>
    <p><?php echo 'PHP ' . PHP_VERSION; ?></p>
  </div>
</body>
</html>
