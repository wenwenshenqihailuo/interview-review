@echo off
title 面试复盘 - 后台
cd /d "C:\Users\macob\Desktop\复盘"
taskkill /F /IM node.exe /FI "WINDOWTITLE eq 面试复盘*" >nul 2>&1
echo.
echo  管理面板: http://localhost:8888/admin
echo  客户页面: http://localhost:8888/customer
echo.
start http://localhost:8888/admin
node server.mjs
