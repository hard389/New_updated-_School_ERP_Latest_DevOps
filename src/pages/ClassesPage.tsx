import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/DataTable';
import { DataFormDialog } from '@/components/DataFormDialog';
import { classService } from '@/services/firebaseService';
import { toast } from '@/hooks/use-toast';
import type { ClassGroup } from '@/types';
import { Layers, Plus, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export default function ClassesPage() {
  const [classes, setClasses] = useState<ClassGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingClass, setEditingClass] = useState<ClassGroup | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Pagination States
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const classData = await classService.getAll();
      
      // Jani yahan Data Sequencing (Sorting) ho rahi hai
      // Pehle Grade ke hisaab se sort hoga, phir Section ke hisaab se
      const sortedData = [...classData].sort((a, b) => {
        if (Number(a.grade) !== Number(b.grade)) {
          return Number(a.grade) - Number(b.grade);
        }
        return String(a.section).localeCompare(String(b.section));
      });

      setClasses(sortedData);
    } catch (error) {
      console.error('Error fetching classes:', error);
      toast({
        title: 'Error',
        description: 'Failed to fetch classes data',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const columns = [
    { key: 'name', label: 'Class Name' },
    { key: 'grade', label: 'Grade' },
    { key: 'section', label: 'Section' },
    { key: 'studentCount', label: 'Students' },
  ];

  const formFields = [
    { name: 'name', label: 'Class Name', type: 'text' as const, required: true, placeholder: 'e.g., 10th A' },
    { name: 'grade', label: 'Grade', type: 'number' as const, required: true, placeholder: '10' },
    { name: 'section', label: 'Section', type: 'text' as const, required: true, placeholder: 'A' },
    { name: 'studentCount', label: 'Student Count', type: 'number' as const, placeholder: '40' },
    { name: 'classTeacherId', label: 'Class Teacher ID', type: 'text' as const, placeholder: 'Faculty ID' },
  ];

  const handleSubmit = async (data: Record<string, any>) => {
    setIsSaving(true);
    try {
      if (editingClass) {
        await classService.update(editingClass.id, data);
        toast({ title: 'Updated', description: 'Class updated successfully' });
      } else {
        await classService.create(data as any);
        toast({ title: 'Created', description: 'Class created successfully' });
      }
      await fetchData();
      setEditingClass(null);
      setIsDialogOpen(false); // Form band karne ke liye
    } catch (error) {
      console.error('Error saving class:', error);
      toast({
        title: 'Error',
        description: 'Failed to save class',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    try {
      await classService.delete(deletingId);
      toast({ title: 'Deleted', description: 'Class deleted successfully' });
      
      // Agar page par aakhri item tha aur wo delete ho gaya, toh pichle page par le jao
      const isLastItemOnPage = currentData.length === 1;
      if (isLastItemOnPage && currentPage > 1) {
        setCurrentPage((prev) => prev - 1);
      }
      
      await fetchData();
    } catch (error) {
      console.error('Error deleting class:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete class',
        variant: 'destructive',
      });
    } finally {
      setDeletingId(null);
    }
  };

  // Pagination Calculations
  const totalPages = Math.max(1, Math.ceil(classes.length / itemsPerPage));
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, classes.length);
  const currentData = classes.slice(startIndex, endIndex);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 p-6">
        <div className="absolute -top-10 -right-10 w-40 h-40 bg-gradient-to-bl from-chart-1/15 to-transparent rounded-full blur-3xl" />
        <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-chart-1/20 to-chart-1/5 ring-1 ring-chart-1/20">
              <Layers className="h-6 w-6 text-chart-1" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Classes</h1>
              <p className="text-muted-foreground">Manage school classes and sections</p>
            </div>
          </div>
          <Button
            onClick={() => setIsDialogOpen(true)}
            className="rounded-xl bg-gradient-to-r from-primary to-accent hover:opacity-90 hover:shadow-lg hover:shadow-primary/25 transition-all duration-300"
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Class
          </Button>
        </div>
      </div>

      <Card className="glass-card overflow-hidden hover:shadow-lg transition-shadow duration-300">
        <CardHeader className="border-b border-border/50 bg-gradient-to-r from-secondary/20 to-transparent">
          <CardTitle className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-chart-1/10 ring-1 ring-chart-1/20">
              <Layers className="h-4 w-4 text-chart-1" />
            </div>
            Classes List
          </CardTitle>
          <CardDescription>
            {classes.length} classes registered
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4 pb-6">
          <DataTable
            columns={columns}
            data={currentData} 
            isLoading={isLoading}
            onEdit={(row) => {
              setEditingClass(row);
              setIsDialogOpen(true);
            }}
            onDelete={(row) => setDeletingId(row.id)}
          />

          {/* Pagination Controls - Bilkul Image Jaisa */}
          {!isLoading && classes.length > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between mt-6 text-sm text-muted-foreground pt-4 gap-4">
              <div>
                Showing <span className="font-medium text-foreground">{startIndex + 1}</span> to{' '}
                <span className="font-medium text-foreground">{endIndex}</span> of{' '}
                <span className="font-medium text-foreground">{classes.length}</span> entries
              </div>
              
              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                  disabled={currentPage === 1}
                  className="rounded-lg bg-transparent border-border/50 hover:bg-secondary/20"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" /> Previous
                </Button>
                
                <span className="font-medium text-foreground">
                  {currentPage} / {totalPages}
                </span>
                
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                  disabled={currentPage === totalPages}
                  className="rounded-lg bg-transparent border-border/50 hover:bg-secondary/20"
                >
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <DataFormDialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) setEditingClass(null);
        }}
        title={editingClass ? 'Edit Class' : 'Add Class'}
        fields={formFields}
        initialData={editingClass || {}}
        onSubmit={handleSubmit}
        isLoading={isSaving}
      />

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent className="glass-card border border-border/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/20">
                <AlertCircle className="h-5 w-5 text-destructive" />
              </div>
              Delete Class
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this class? This will affect all related data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl border-2">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:shadow-lg hover:shadow-destructive/25 transition-all duration-300"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
