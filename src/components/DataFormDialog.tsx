import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface FormField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'email' | 'select' | 'multiselect';
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
}

interface DataFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  fields: FormField[];
  initialData?: Record<string, any>;
  onSubmit: (data: Record<string, any>) => Promise<void>;
  isLoading?: boolean;
}

export function DataFormDialog({
  open,
  onOpenChange,
  title,
  fields,
  initialData,
  onSubmit,
  isLoading,
}: DataFormDialogProps) {
  const [formData, setFormData] = useState<Record<string, any>>(initialData || {});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = (name: string, value: any) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: '' }));
    }
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    for (const field of fields) {
      if (field.required && !formData[field.name]) {
        newErrors[field.name] = `${field.label} is required`;
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    await onSubmit(formData);
    setFormData({});
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-2 border-border">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {fields.map((field) => (
            <div key={field.name} className="space-y-2">
              <Label htmlFor={field.name} className="text-sm font-medium">
                {field.label}
                {field.required && <span className="text-destructive ml-1">*</span>}
              </Label>

              {field.type === 'select' ? (
                <Select
                  value={formData[field.name] || ''}
                  onValueChange={(value) => handleChange(field.name, value)}
                >
                  <SelectTrigger className="border-2">
                    <SelectValue placeholder={field.placeholder || `Select ${field.label}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options?.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={field.name}
                  type={field.type}
                  value={formData[field.name] || ''}
                  onChange={(e) =>
                    handleChange(
                      field.name,
                      field.type === 'number' ? Number(e.target.value) : e.target.value
                    )
                  }
                  placeholder={field.placeholder}
                  className="border-2"
                />
              )}

              {errors[field.name] && (
                <p className="text-sm text-destructive">{errors[field.name]}</p>
              )}
            </div>
          ))}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-2"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading} className="border-2">
              {isLoading ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
