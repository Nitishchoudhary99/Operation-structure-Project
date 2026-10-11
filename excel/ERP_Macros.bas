Attribute VB_Name = "ERP_Macros"
'==============================================================================
' SmartTrader ERP - optional power-up macros
' Install: open SmartTrader_ERP.xlsx > File > Save As > "Excel Macro-Enabled
' Workbook (*.xlsm)" > Alt+F11 > File > Import File... > ERP_Macros.bas
' Then Alt+F8 to run, or assign macros to shapes on the Dashboard.
' The workbook works fully WITHOUT these macros - they only add speed/comfort.
'==============================================================================
Option Explicit

Private Const FIRST_ROW As Long = 5

' ---------- Fast Mode: switch off recalculation while bulk-entering data -----
Public Sub FastModeOn()
    Application.Calculation = xlCalculationManual
    Application.ScreenUpdating = True
    Application.StatusBar = "SmartTrader ERP: FAST MODE ON - press F9 or run FastModeOff to refresh totals"
End Sub

Public Sub FastModeOff()
    Application.Calculation = xlCalculationAutomatic
    Application.Calculate
    Application.StatusBar = False
End Sub

' ---------- Start a new sales invoice on the next free row -------------------
Public Sub NewInvoice()
    Dim ws As Worksheet, r As Long
    Set ws = ThisWorkbook.Worksheets("Sales")
    r = NextFreeRow(ws, 4)          ' column D = Item
    ws.Activate
    ws.Cells(r, 1).Value = Date
    ws.Cells(r, 2).Value = ThisWorkbook.Worksheets("Dashboard").Range("J15").Value  ' NEXT INVOICE No.
    ws.Cells(r, 9).Value = "Pending"
    ws.Cells(r, 3).Select
End Sub

' ---------- Add another line to the invoice above ----------------------------
Public Sub AddInvoiceLine()
    Dim ws As Worksheet, r As Long
    Set ws = ThisWorkbook.Worksheets("Sales")
    r = NextFreeRow(ws, 4)
    If r = FIRST_ROW Then NewInvoice: Exit Sub
    ws.Activate
    ws.Range(ws.Cells(r - 1, 1), ws.Cells(r - 1, 3)).Copy ws.Cells(r, 1)
    ws.Cells(r, 8).Value = ws.Cells(r - 1, 8).Value
    ws.Cells(r, 9).Value = ws.Cells(r - 1, 9).Value
    ws.Cells(r, 4).Select
End Sub

' ---------- New purchase line ------------------------------------------------
Public Sub NewPurchase()
    Dim ws As Worksheet, r As Long
    Set ws = ThisWorkbook.Worksheets("Purchases")
    r = NextFreeRow(ws, 4)
    ws.Activate
    ws.Cells(r, 1).Value = Date
    ws.Cells(r, 2).Select
End Sub

' ---------- Save the Invoice sheet as PDF next to the workbook ---------------
Public Sub InvoiceToPDF()
    Dim inv As String, path As String
    inv = CStr(ThisWorkbook.Worksheets("Invoice").Range("C7").Value)
    If inv = "" Then MsgBox "No invoice selected.", vbExclamation: Exit Sub
    path = ThisWorkbook.Path & Application.PathSeparator & "Invoices"
    If Dir(path, vbDirectory) = "" Then MkDir path
    path = path & Application.PathSeparator & inv & ".pdf"
    ThisWorkbook.Worksheets("Invoice").ExportAsFixedFormat Type:=xlTypePDF, Filename:=path, _
        Quality:=xlQualityStandard, OpenAfterPublish:=True
End Sub

' ---------- One-click timestamped backup -------------------------------------
Public Sub BackupNow()
    Dim path As String
    path = ThisWorkbook.Path & Application.PathSeparator & "Backups"
    If Dir(path, vbDirectory) = "" Then MkDir path
    path = path & Application.PathSeparator & "ERP_" & Format(Now, "yyyy-mm-dd_hhnn") & ".xlsm"
    ThisWorkbook.SaveCopyAs path
    MsgBox "Backup saved:" & vbLf & path, vbInformation
End Sub

' ---------- Remove demo data (input cells only - formulas stay intact) -------
Public Sub ClearDemoData()
    If MsgBox("Delete ALL demo entries from Sales, Purchases, CashBook, Adjustments, Items and Parties?" _
              & vbLf & "Formulas are kept. This cannot be undone.", vbYesNo + vbCritical) <> vbYes Then Exit Sub
    FastModeOn
    ClearInputs "Sales", 9, 3004
    ClearInputs "Purchases", 8, 3004
    ClearInputs "CashBook", 8, 3004
    ClearInputs "Adjustments", 5, 504
    ClearInputs "Items", 11, 504
    ClearInputs "Parties", 9, 304
    FastModeOff
    MsgBox "Demo data cleared. Fill Settings, Items and Parties to go live.", vbInformation
End Sub

Private Sub ClearInputs(sheetName As String, inputCols As Long, lastRow As Long)
    With ThisWorkbook.Worksheets(sheetName)
        .Range(.Cells(FIRST_ROW, 1), .Cells(lastRow, inputCols)).ClearContents
    End With
End Sub

' ---------- Year-end: copy closing stock & balances as next year's opening ---
' Run in a COPY of the file (Save As new FY name first).
Public Sub CarryForwardToNewYear()
    Dim it As Worksheet, pt As Worksheet, r As Long
    If MsgBox("Run this only in the NEW year's copy of the file." & vbLf & _
              "Closing stock and party balances become opening values and all transactions are cleared. Continue?", _
              vbYesNo + vbExclamation) <> vbYes Then Exit Sub
    Set it = ThisWorkbook.Worksheets("Items")
    Set pt = ThisWorkbook.Worksheets("Parties")
    Application.Calculate
    For r = FIRST_ROW To 504
        If it.Cells(r, 1).Value <> "" Then
            it.Cells(r, 11).Value = it.Cells(r, 16).Value   ' Opening Rate <- Avg Cost
            it.Cells(r, 10).Value = it.Cells(r, 15).Value   ' Opening Qty  <- Closing Stock
        End If
    Next r
    For r = FIRST_ROW To 304
        If pt.Cells(r, 1).Value <> "" Then pt.Cells(r, 9).Value = pt.Cells(r, 14).Value
    Next r
    FastModeOn
    ClearInputs "Sales", 9, 3004
    ClearInputs "Purchases", 8, 3004
    ClearInputs "CashBook", 8, 3004
    ClearInputs "Adjustments", 5, 504
    With ThisWorkbook.Worksheets("Settings").Range("B9")
        .Value = DateSerial(Year(.Value) + 1, Month(.Value), Day(.Value))
    End With
    FastModeOff
    MsgBox "New year ready. Update cash/bank opening balances in Settings (A18:B25).", vbInformation
End Sub

' ---------- Amount in words (Indian system) - usable as a cell formula -------
' =AmountInWords(Invoice!K39)
Public Function AmountInWords(ByVal amt As Double) As String
    Dim rupees As Double, paise As Long, s As String
    rupees = Int(amt)
    paise = CLng(Round((amt - rupees) * 100, 0))
    If rupees = 0 Then s = "Zero" Else s = IndianWords(rupees)
    s = "Rupees " & s
    If paise > 0 Then s = s & " and " & Words99(paise) & " Paise"
    AmountInWords = s & " Only"
End Function

Private Function IndianWords(ByVal n As Double) As String
    Dim s As String
    If n >= 10000000# Then s = s & IndianWords(Int(n / 10000000#)) & " Crore ": n = n - Int(n / 10000000#) * 10000000#
    If n >= 100000 Then s = s & Words99(Int(n / 100000)) & " Lakh ": n = n - Int(n / 100000) * 100000
    If n >= 1000 Then s = s & Words99(Int(n / 1000)) & " Thousand ": n = n - Int(n / 1000) * 1000
    If n >= 100 Then s = s & Words99(Int(n / 100)) & " Hundred ": n = n - Int(n / 100) * 100
    If n > 0 Then s = s & Words99(CLng(n))
    IndianWords = Trim$(s)
End Function

Private Function Words99(ByVal n As Long) As String
    Dim ones, tens
    ones = Array("", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", _
                 "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen")
    tens = Array("", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety")
    If n < 20 Then
        Words99 = ones(n)
    Else
        Words99 = Trim$(tens(n \ 10) & " " & ones(n Mod 10))
    End If
End Function

Private Function NextFreeRow(ws As Worksheet, col As Long) As Long
    Dim r As Long
    r = ws.Cells(ws.Rows.Count, col).End(xlUp).Row
    If r < FIRST_ROW Then r = FIRST_ROW - 1
    NextFreeRow = r + 1
End Function
