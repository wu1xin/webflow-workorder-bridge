import { Example } from '../example.js'

// 样例工具：验证 subpath exports 用
export function formatWorkOrderNo(no: string): string {
  return no.trim().toUpperCase()
}

export function formatDate(date: Example): string {
  return date
}