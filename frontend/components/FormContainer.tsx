import React from "react";

interface FormContainerProps {
  title: string;
  children: React.ReactNode;
}

// The sheet of paper the sign-in, sign-up and password pages are written on.
export default function FormContainer({ title, children }: FormContainerProps) {
  return (
    <div className="mx-auto mt-10 max-w-md px-4 md:mt-16">
      <div className="card rise md:p-8" style={{ "--rise": "16px" } as React.CSSProperties}>
        <h1 className="mb-6 text-center text-3xl md:text-4xl">{title}</h1>
        {children}
      </div>
    </div>
  );
}
