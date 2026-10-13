import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2, Download } from 'lucide-react';

interface Column {
  key: string;
  label: string;
  render?: (value: any, row: any) => React.ReactNode;
}

interface DataTableProps {
  columns: Column[];
  data: any[];
  onEdit?: (row: any) => void;
  onDelete?: (row: any) => void;
  isLoading?: boolean;
  exportFileName?: string;
}

export function DataTable({
  columns,
  data,
  onEdit,
  onDelete,
  isLoading,
  exportFileName = 'data',
}: DataTableProps) {
  const handleExport = () => {
    // Convert data to CSV
    const headers = columns.map(col => col.label).join(',');
    const rows = data.map(row =>
      columns.map(col => {
        const value = col.render ? col.render(row[col.key], row) : row[col.key];
        // Handle values that might contain commas or quotes
        const stringValue = String(value || '');
        return stringValue.includes(',') || stringValue.includes('"')
          ? `"${stringValue.replace(/"/g, '""')}"`
          : stringValue;
      }).join(',')
    );
    const csv = [headers, ...rows].join('\n');

    // Create and download file
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `${exportFileName}_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <p className="text-lg font-medium">No data found</p>
        <p className="text-sm">Add new entries to see them here</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Export Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleExport}
          variant="outline"
          size="sm"
          className="border-2"
        >
          <Download className="mr-2 h-4 w-4" />
          Export to CSV
        </Button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border-2 border-border rounded-xl">
        <Table>
          <TableHeader>
            <TableRow className="border-b-2 border-border bg-muted">
              {columns.map((column) => (
                <TableHead key={column.key} className="font-bold">
                  {column.label}
                </TableHead>
              ))}
              {(onEdit || onDelete) && (
                <TableHead className="text-right font-bold">Actions</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row, index) => (
              <TableRow
                key={row.id || index}
                className="border-b border-border transition-colors hover:bg-muted/50"
              >
                {columns.map((column) => (
                  <TableCell key={column.key}>
                    {column.render
                      ? column.render(row[column.key], row)
                      : row[column.key]}
                  </TableCell>
                ))}
                {(onEdit || onDelete) && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {onEdit && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => onEdit(row)}
                          className="h-8 w-8 border-2"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {onDelete && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => onDelete(row)}
                          className="h-8 w-8 border-2 hover:bg-destructive hover:text-destructive-foreground"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
