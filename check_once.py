# -*- coding: utf-8 -*-
"""
單次檢查腳本（不開網頁）。
用途：給 Windows 工作排程器定時呼叫，即使沒開網頁工具也能自動檢查並推播。
執行： python check_once.py
"""
import app as A

if __name__ == "__main__":
    checked, notified = A.check_all()
    print(f"檢查 {checked} 筆，推播 {notified} 則通知。")
